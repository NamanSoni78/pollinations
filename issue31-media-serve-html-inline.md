# media.pollinations.ai stores and serves attacker-chosen Content-Types inline — arbitrary HTML/SVG hosting on a first-party domain, no nosniff, no CSP, no sandbox

## Summary

Any of the three upload paths on `media.pollinations.ai` accepts whatever `Content-Type` the client declares and serves it back verbatim, inline, on the trusted `pollinations.ai` domain:

```ts
// media.pollinations.ai/src/index.ts (raw upload path, ~line 533)
const upload = await uploadUnlistedMedia(c.env, body, {
    contentType: requestContentType,   // = the request's own Content-Type header
    ...
});

// media.pollinations.ai/src/index.ts (~line 243, JSON path)
contentType: z.string().optional(),    // no allowlist

// media.pollinations.ai/src/multipart-upload.ts (~line 161)
contentType: info.mimeType,            // client-declared
```

`uploadUnlistedMedia` (`media.pollinations.ai/src/media-upload.ts:66-90`) writes that value to the R2 object's `httpMetadata.contentType`, and the public unauthenticated `GET /:id` handler serves it through `readMedia` (`media-upload.ts:108-150`) with:

- the stored `Content-Type` (line 119-121),
- `Content-Disposition: inline` when an original filename is present (lines 132-137),
- **no `X-Content-Type-Options: nosniff`**, **no `Content-Security-Policy`**, **no `X-Frame-Options`** — nothing.

There is no content-type allowlist anywhere on the user-upload path. The built-in extension→MIME map even includes `svg: "image/svg+xml"` (`index.ts:1186`), i.e. active content served inline by design. Uploads are authenticated, but any key works — including publishable `pk_` keys that ship inside public clients (the service's own docs note this: "Uploads require a pollinations.ai API key (`pk_` or `sk_`)", `index.ts:1156`).

The platform already knows how dangerous this is on the *generated*-file path: `gen.pollinations.ai/src/image/handler.ts:216-225` deliberately serves generated SVGs with `Content-Security-Policy: default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`. The user-upload path has no equivalent.

## Evidence (reproduction)

```bash
# 1. Upload arbitrary HTML with any valid key
curl -X POST https://media.pollinations.ai/upload \
     -H "Authorization: Bearer $ANY_PK_OR_SK_KEY" \
     -H "Content-Type: text/html" \
     --data-binary @phishing.html
# → { "id": "...", "url": "https://media.pollinations.ai/<uuid>", ... }

# 2. Fetch it back (no auth on GET)
curl -i https://media.pollinations.ai/<uuid>
# → 200, Content-Type: text/html, Content-Disposition: inline
#   (no nosniff, no CSP, no sandbox, no frame-ancestors)
```

The same works with `image/svg+xml` (embedded `<script>` executes on that origin when the URL is navigated directly) and any other active type. Blob retention is 30 days and refreshes on access (`index.ts:1010-1015`), so a linked page keeps itself alive indefinitely.

## Why it matters

1. **First-party phishing/malware hosting.** `https://media.pollinations.ai/<uuid>` serving attacker-authored HTML with the platform's domain, TLS and reputation survives link scanners and domain checks in a way an attacker-controlled host never does. This is a standard high-severity finding for any service that combines user uploads with public serving.
2. **It is the hosting half of a CSRF chain against the auth API.** Because the served content is active on a `*.pollinations.ai` origin, and that origin pattern is wildcard-trusted by enter's better-auth `trustedOrigins` (filed separately), a page hosted here can issue cookie-authenticated writes to `enter.pollinations.ai/api/auth/*` — see the companion issue. Even without that chain, origin-level script execution on a platform subdomain is enough.
3. **No defense-in-depth.** No `nosniff` means a mislabeled upload also content-sniffs; no `frame-ancestors`/`X-Frame-Options` means the URL can be iframed into any page for clickjacking.

## Fix

Two layers, either closes the active-content problem; both are cheap:

1. **Upload-time allowlist** (preferred): accept only media types the platform actually intends to host — `image/*` (excluding `image/svg+xml` unless sanitized), `audio/*`, `video/*`, `application/octet-stream`, and the model-file types if needed. Reject everything else with a 400 at all three ingestion paths (raw / JSON / multipart).
2. **Serve-time hardening** (do regardless, mirrors gen's SVG policy): on `readMedia`, add `X-Content-Type-Options: nosniff` to every response, and for any non-media Content-Type (or anything text/html-ish) add `Content-Security-Policy: default-src 'none'; sandbox` and `Content-Disposition: attachment`.

Regression test: upload `Content-Type: text/html` → expect 400 (allowlist) or served with `nosniff` + `CSP: sandbox` + `attachment`; upload a normal PNG → unchanged behavior.
