# issue 69 — Stored XSS / arbitrary content hosting on `media.pollinations.ai`: raw-upload content-type is stored and replayed verbatim (`text/html` accepted; no CSP, no `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`)

**Severity: high (arbitrary attacker-controlled HTML+JS permanently hosted and executed on an official Pollinations origin; works with any `pk_`/`sk_` key, one unauthenticated-to-attacker request, immutable-CDN-cached)**
**Status: LIVE in production, verified 2026-10-23 (benign marker payload uploaded, served, and header-inspected via curl; content cleaned up where the API allows)**

## Summary

`media.pollinations.ai` accepts file uploads from **any valid API key — including free publishable `pk_` app keys** (issue 65 established the type-blind auth) — and stores the caller's **request `Content-Type` header as the object's served `Content-Type`, with no allowlist**. The retrieval route then serves those bytes with that content-type, `Content-Disposition: inline`, and **no `Content-Security-Policy` and no `X-Content-Type-Options: nosniff`**. The result: an attacker can host and execute arbitrary HTML/JavaScript at `https://media.pollinations.ai/<id>`, an official Pollinations domain, indefinitely (30-day TTL, refreshed by GETs; `Cache-Control: public, max-age=31536000, immutable`).

The contrast with the generation path shows this is an oversight, not a design decision: `gen.pollinations.ai/src/image/handler.ts:229-235` **already hardens SVG generation responses** with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` + `X-Content-Type-Options: nosniff` precisely because an `image/svg+xml` response on a Pollinations origin is an XSS vector. The media upload/serve path applies none of that hardening, to any content type, including `text/html`.

Where it happens:

- `media.pollinations.ai/src/index.ts:488-545` — the **raw upload path**: any request whose `Content-Type` is neither `multipart/form-data` nor `application/json` is treated as a raw body upload, and `contentType: requestContentType` is passed through to storage **verbatim** (`uploadUnlistedMedia` → `MEDIA_BUCKET.put` with `httpMetadata.contentType`). There is no image/audio/video check and no blocklist (`text/html`, `image/svg+xml`, `application/xhtml+xml`, … all pass).
- `media.pollinations.ai/src/media-upload.ts:66-90` — `uploadUnlistedMedia` stores `input.contentType || "application/octet-stream"`; JSON uploads (`index.ts:593-596`) take `body.contentType` validated only as `z.string()`; multipart uploads take the part's content-type or a filename extension guess.
- `media.pollinations.ai/src/media-upload.ts:108-145` — `readMedia` builds the GET response with `Content-Type: <stored>` and **only** adds `X-Content-Id`, `X-Content-Size`, `Link`, and `Content-Disposition: inline; filename*=…` (the latter when an upload filename was recorded). **No CSP. No nosniff. No sandbox.**
- `media.pollinations.ai/src/index.ts:1010-1049` — `GET /:id` returns that response to any browser, unauthenticated. It also refreshes the object's 30-day retention once it is ≥15 days old, so a payload that anyone keeps visiting **never expires**.
- The upload endpoint is unthrottled and unquota'd per account (issue 65), so this scales.

Live verification (attacker role only; benign marker payload):

```
$ curl -s -X POST 'https://media.pollinations.ai/upload' \
    -H 'Authorization: Bearer sk_…' \
    -H 'Content-Type: text/html' \
    -H 'X-File-Name: poc-w20.html' \
    --data-binary '<!doctype html><html><body><h1>pollinations-bounty-poc-w20-xss</h1><script>document.title="poc-w20-xss-executed"</script></body></html>'
{"id":"b55c5966-142f-4ef1-bcc7-2a08ff8a49e1","url":"https://media.pollinations.ai/b55c5966-142f-4ef1-bcc7-2a08ff8a49e1","contentType":"text/html","size":135}

$ curl -s -D- 'https://media.pollinations.ai/b55c5966-142f-4ef1-bcc7-2a08ff8a49e1'
HTTP/2 200
content-type: text/html
content-disposition: inline; filename*=UTF-8''poc-w20.html
cache-control: public, max-age=31536000, immutable
x-content-id: b55c5966-142f-4ef1-bcc7-2a08ff8a49e1
(no content-security-policy header)
(no x-content-type-options header)

<!doctype html><html><body><h1>pollinations-bounty-poc-w20-xss</h1><script>…</script></body></html>
```

A browser navigating to that URL parses it as HTML and runs the script on the `media.pollinations.ai` origin. The same works with `Content-Type: image/svg+xml` (scripts in SVG execute on top-level navigation; the upload path, unlike gen's image handler, adds no CSP to it).

## Attack (attacker-only, one request, no victim cooperation to plant)

Attacker = anyone holding **any** valid key — publishable `pk_` app keys embedded in public client-side apps are trivially obtainable by creating any app (issue 65's auth finding), or any free-tier user's `sk_`:

1. `POST /upload` with `Content-Type: text/html` and an HTML payload (raw path, 400 MiB cap, no rate limit) → 200 with the public URL.
2. Optionally tag the upload (JSON/multipart paths accept `tags`) so it appears in the **public gallery** `GET /media?tag=…` alongside real content on the official site.
3. Serve: the URL renders attacker HTML on `media.pollinations.ai` with immutable caching. Retention refreshes on visit, so it stays alive as long as it is visited.
4. Uses, in increasing order of harm:
   - **Credential phishing on a trusted origin**: pixel-perfect `enter.pollinations.ai` sign-in lookalike at an official `*.pollinations.ai` URL (the real sign-in is OAuth-popups on a different subdomain, so users have no visual cue that media.* is not an auth surface).
   - **Malware/illegal content hosting on Pollinations' domain and CDN** — reputation, legal, and clean-up costs (R2 objects are immutable-cached; untagged uploads **cannot be deleted even by their uploader**, and no admin delete route exists for them).
   - **Origin-resident script on media.pollinations.ai**: can read the public tag galleries, poll its own upload API with the attacker's key, and generally use the origin as a launchpad. (Direct cookie theft is bounded: better-auth session cookies are host-only on `enter.pollinations.ai` and `SameSite=Lax`, so they are not readable or sendable cross-origin from media.* — the primary impact is trusted-domain phishing/content hosting, not session hijack.)

## Fix (minimal)

Harden the boundary where caller bytes become a served response — mirror what gen's image handler already does:

- In `media.pollinations.ai/src/index.ts` (raw path ~:533 and JSON path ~:594) and `media-upload.ts`: **allowlist upload content types** to `image/*`, `audio/*`, `video/*`, `model/*`, `text/plain`, `application/zip`, `application/octet-stream` (reject `text/html`, `image/svg+xml`, `application/xhtml+xml`, `text/xml`, and anything with parameters that reparse as HTML).
- In `readMedia` (`media-upload.ts:108-145`): always set `X-Content-Type-Options: nosniff` and a restrictive `Content-Security-Policy: default-src 'none'; sandbox` (or `Content-Disposition: attachment`) for every served object; for any `image/svg+xml` specifically, apply the same CSP gen uses (`image/handler.ts:229-235`).
- Pair with issue 65's recommendations (rate limit + quota + type-checked key auth) — with those, planting becomes costly; with this fix, planting becomes inert.

Cross-references: issue 65 (same endpoint, unthrottled/unquota'd + `pk_` upload auth — makes this scalable), issue 64 (fleet disclosure, different surface). Gen-side SVG responses are already hardened (`gen.pollinations.ai/src/image/handler.ts:229-235`), which sets the repo's own bar for what serving untrusted media on a Pollinations origin requires.
