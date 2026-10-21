# media uploads are unthrottled, unquota'd and unmoderated — any `pk_` key (or free account) can push 400 MiB bodies in a loop, publish to public tag galleries, and keep blobs alive forever with unauthenticated GETs; untagged blobs can never be deleted by anyone

## Summary

The media worker has no rate limit, no storage quota, and no moderation hook anywhere (verified: zero 429s in the worker; the gen edge limiter does not apply to this separate route):

- **Upload auth is any valid key** — including publishable `pk_` keys that by design ship inside public clients (`index.ts:376-388` performs no tier/quota check; the worker's own docs say "Uploads require a pollinations.ai API key (`pk_` or `sk_`)").
- **Tags need only `userId ≠ null`** (`index.ts:558-565`) — but tagging works with a pk_ key attached to an account (verified by the worker's own tests: `integration.test.ts:1224-1253` publishes via `pk_alice`). Tagged items appear in the **public, auth-free gallery** (`GET /media?tag=…`) with **zero content moderation** — compounding the filed Content-Type issue: `text/html`/`image/svg+xml` uploads become publicly-listed, inline-served pages on `media.pollinations.ai`.
- **Retention is attacker-controlled**: a public `GET /:id` every ≤ 15 days refreshes the 30-day TTL forever (`shared/r2-storage.ts:33-50`), and the request is unauthenticated. A cron with a URL list keeps arbitrary storage alive indefinitely.
- **Untagged blobs are immortal by policy**: the DELETE route requires ownership via a catalog row, and untagged uploads have no catalog entry (`index.ts:841-846` returns 404 for them) — nobody, including the platform via the API, can delete them. The DPA itself acknowledges account deletion cannot purge untagged uploads (`operations/legal/DATA_PROCESSING_ADDENDUM.md:9`).
- Per-request cap is 400 MiB (`wrangler.toml` `uploadMaxSize`), so a single loop is ~13 TB/day of Class-A ops + storage growth per key.

## Scenario

1. Lift any `pk_` key from any deployed public client (or register a free account).
2. `while true; curl -X POST media.pollinations.ai/upload -H "Authorization: Bearer pk_..." -H "Content-Type: text/html" --data-binary @payload.html; done` — unbounded R2 storage/Class-A cost, no throttle.
3. Optionally `?tags=popular` to appear in the public gallery on the Pollinations domain.
4. Hit each URL monthly from any anonymous client — storage is never reclaimed.

## Fix (minimal, mirrors in-repo patterns)

1. Per-key upload rate limit + total storage quota (a KV/DO counter — the `PollenRateLimiter` shape already exists in gen).
2. Require `sk_` (non-run-token) for **tagging/publishing** — same rationale as the existing DELETE rule — or add a moderation hook before a tag listing becomes public.
3. Rate-limit TTL refresh per object (e.g. refresh counts only for objects requested by ≥1 authenticated read, or cap refreshes per object per window).
4. Give accounts a way to list and delete their own untagged uploads (track uploads by `uploadedBy` in the catalog without requiring tags).
