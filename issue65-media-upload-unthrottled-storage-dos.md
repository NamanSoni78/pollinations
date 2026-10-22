# issue 65 — `media.pollinations.ai` upload: no rate limit, no quota, any valid key (including publishable `pk_`)

**Severity: medium-low (unbounded storage / catalog growth = cost DoS; amplifies issue 31)**
**Status: LIVE in production, verified 2026-10-22 (live PoC with cleanup)**

## Summary

The media worker accepts uploads from **any valid API key — including publishable `pk_` keys that ship inside public SDKs and demo clients** — with **no per-account or per-key rate limit, quota, or file-count cap**, up to **400 MiB per file**:

- `media.pollinations.ai/src/index.ts:426-434, 1156` — upload authorization is a call to gen `/account/key`; only key **validity** is checked, never the key **type** (`publishable` keys pass).
- `media.pollinations.ai/wrangler.toml` — `MAX_FILE_SIZE=419430400` (400 MiB); multipart/raw bodies stream straight to R2; **no `ratelimits` binding is configured anywhere in the worker** (contrast gen's `edgeRateLimit` at 10 req/s/IP).
- `media.pollinations.ai/src/index.ts:655-688` — only *tagging* (public gallery) and *custom ids* require a user-attached key; a plain untagged upload works with a bare `pk_`.

Retention compounds the cost: objects live 30 days (`r2-lifecycle.json`) **and `GET /:id` refreshes the TTL of any object ≥15 days old** (`shared/r2-storage.ts:33-77`), so an attacker keeps their own uploads alive indefinitely with trivial public GETs — there is no authenticated path that can evict untagged uploads (delete requires an `sk_` **and** a catalog row: `index.ts:897-1006` notes untagged uploads are undeletable 404s).

Secondary hardening gaps on the same worker:

1. **`%2F` in the retrieval path reaches R2 verbatim** — Hono decodes percent-escapes in `c.req.param()`, so `GET /pending%2F<uuid>` becomes `R2.get("pending/<uuid>")` (`index.ts:1008-1049` → `src/media-upload.ts:114-116`), reading a **staged multipart upload of another user** during the upload window (`multipart-upload.ts:34,50`). Keys are random UUIDs, so this is theoretical today — but any future prefixed key layout becomes silently world-readable.
2. **`?key=` query-parameter auth** (`index.ts:120-126`) — same key-in-URL class as issue 55.

## Attack

Attacker-only; live-verified with my own account (then cleaned up):

1. Take a `pk_` from any public Pollinations SDK/demo (they are designed to be embedded) — no sign-in, no spend.
2. `POST https://media.pollinations.ai/upload` in a loop, each carrying up to 400 MiB. Two back-to-back 43-byte probes both returned `200` in ~2.5 s with **no rate-limit headers, no quota error, no per-account file cap**:

```
upload#1: 200 in 2.54s -> {'id': '0f646c62-…', 'contentType': 'text/plain', 'size': 43, …}
upload#2: 200 in 2.56s -> {'id': 'f3c3dd01-…', 'contentType': 'text/plain', 'size': 44, …}
```

3. `GET` each uploaded URL once per ~15-day window to refresh TTLs forever; permanent storage scales with upload volume only (1 TiB = ~2,621 max-size uploads, sustained by ~175 GETs/day).
4. The D1 catalog is **enter's production database** (`wrangler.toml:65-70`), so the same flood also burns D1 write quota on the account DB.

## Fix (minimal)

- Reject `publishable` keys for upload (or require a user-attached key): one `type` check where `verifyApiKey`'s attestation is already read.
- Add a per-key/per-account rate limit and total-bytes quota (a simple KV counter like the quest-check throttle at `enter routes/account.ts:1259-1273`).
- Strip/normalize `%2F` (and any `/`) from the `/:id` retrieval param before R2 access.
- Drop the `?key=` channel.
