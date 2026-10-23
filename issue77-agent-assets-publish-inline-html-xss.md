# issue 77 — `assets publish` uploads `text/html`/`image/svg+xml` by design and media serves it inline: keyless stored XSS on `media.pollinations.ai` for any positive Quest Pollen balance, chaining issue 75's unauthenticated RPC write with issue 31's missing serve-time allowlist — on the shared `pollinations.ai` registrable domain (issue 76)

**Severity: critical (attacker-authored script served inline on a platform origin; admission = free account + any positive Quest Pollen; total cost 0.0002 pollen per tool call; no API key ever presented to media; combines three already-filed gaps into a working one-click primitive)**
**Status: LIVE in the tree — every link verified by direct code read 2026-10-24; no live HTML was published during this audit (see Verification)**

## Summary

Issue 31 established that `media.pollinations.ai` serves stored uploads with **no content-type allowlist** — but its write path needed an API key (`pk_` or `sk_`). Issue 75 established that the **`MediaUpload` service-binding RPC** performs writes with **no authentication at all** — but framed the impact as storage-cost DoS.

This issue documents the intersection nobody closed: the RPC write path is reachable from the platform's own MCP servers, and **`computer-mcp`'s `assets publish` explicitly maps `.html` to `text/html` and `.svg` to `image/svg+xml`** when uploading. `readMedia` then serves the object with that stored `Content-Type`, `inline` disposition, and no `Content-Security-Policy`/sandbox. The result is a **stored XSS primitive on `media.pollinations.ai`** whose only admission gate is "any positive balance" — Quest Pollen qualifies — and whose entire cost is the flat `0.0002`-pollen bash tool call.

Because `media.pollinations.ai` sits on the `pollinations.ai` registrable domain (issue 76), the executed script also gains the cookie-authority primitive a `.pollinations.app` origin could never have: it can set `Domain=pollinations.ai` cookies that are transmitted to `enter.pollinations.ai` alongside the victim's real session cookie.

## Evidence table

| Fact | Location |
|---|---|
| `assets publish` maps the uploaded file's extension to a content type, with `html: "text/html; charset=utf-8"`, `htm`, and `svg: "image/svg+xml"` in the table | `apps/computer-mcp/src/assets.ts:38-54` (`CONTENT_TYPES`), `:26` (`contentType: contentTypeFor(path)`) |
| The upload goes through the `MediaUpload` RPC: `media.upload(body, { contentType, fileName, size })` | `apps/computer-mcp/src/assets.ts:21-33` |
| The RPC's `uploadUnlistedMedia` performs **no contentType validation** — `contentType = input.contentType \|\| "application/octet-stream"` — and no auth, no quota, no attribution | `media.pollinations.ai/src/media-upload.ts:66` (quote in issue 75's evidence) |
| `readMedia` serves the stored type verbatim: `Content-Type: object.httpMetadata?.contentType`, `inline` disposition when `originalName` exists, no CSP, no `X-Content-Type-Options` mismatch guard | `media.pollinations.ai/src/media-upload.ts:119-137` |
| A single bash tool call can create and publish the file, billed flat `0.0002` pollen regardless of content | issue 75's verified facts (`apps/computer-mcp/src/server.ts:209-218`; `shared/registry/mcp.ts:67`) |
| Admission to `/mcp/computer` is `requireAccountFunds(c, 0)` — any positive balance, Quest Pollen qualifies; no key is presented to the media worker at all | `gen.pollinations.ai/src/routes/mcp.ts:196-203` (issue 75's citation) |
| RPC uploads create no catalog row → the published HTML is undeletable through the authenticated media API | `media.pollinations.ai/src/media-upload.ts:75-105` (issue 75's citation); issue 65's delete analysis |
| 30-day lifecycle refreshed on read keeps the payload URL alive | `media.pollinations.ai/src/media-upload.ts:142-148` (`refreshR2ObjectTtl`) |
| media serves the response with browser-fetchable CORS and no frame/origin restrictions that would prevent navigation | `media.pollinations.ai/src/index.ts:1109-1128` (`origin: "*"` CORS); no CSP in `readMedia` headers |

## Attack (attacker-only, end to end)

1. Create a free Pollinations account and hold any positive Quest Pollen (signup + any quest reward; this is the only gate `/mcp/computer` checks).
2. Call the computer server's bash tool once:
   ```bash
   printf '<script>document.cookie="better-auth.session_token=pwned; Domain=pollinations.ai; Path=/; Max-Age=31536000";</script>' > x.html
   assets publish x.html
   ```
   The tool call is billed `0.0002` pollen. `share()` stats the file, reads it, and uploads it with `contentType: "text/html; charset=utf-8"` and `fileName: "x.html"`.
3. Receive `https://media.pollinations.ai/<uuid>` — a URL that serves the attacker's HTML **inline on the media origin** (Content-Type `text/html`, `Content-Disposition: inline; filename*=UTF-8''x.html`).
4. Deliver the URL to victims (chat message, QR, link shortener, GitHub README — or automatically inside any platform surface that renders media URLs). On navigation, the script executes on `media.pollinations.ai`.
5. On that origin the payload can (per issue 76): set `Domain=pollinations.ai` cookies (session-shadowing/tossing toward `enter.pollinations.ai`), fetch any media object the victim's cookies permit, and present itself as platform infrastructure.
6. The published object is unattributed (`uploadedBy: "pollinations-service"`, `keyType: "service"` — issue 75), has no catalog row (issue 65 → undeletable via API), and its 30-day TTL refreshes on every read.

Total attacker cost: one free signup, one quest reward, `0.0002` pollen, one HTTP round-trip.

## Verification

Every cited line was read in the current tree (`apps/computer-mcp/src/assets.ts`, `media.pollinations.ai/src/media-upload.ts`, `gen.pollinations.ai/src/routes/mcp.ts`, `media.pollinations.ai/src/index.ts`). No HTML was published to production media storage during this audit; the serve behavior (`inline`, stored type verbatim, no CSP) is directly cited from `readMedia`'s header construction, and the upload admission/billing facts are issue 75's already-verified citations. The cookie-tossing consequence is standard RFC 6265 behavior as analyzed in issue 76.

## Live verification addendum (2026-10-24)

The full mechanism — one tool call → `MediaUpload` RPC → public inline serve → undeletable — was exercised against production with a **benign `.txt` marker** (content: `pollinations bounty poc issue75/77 marker 2026-10-24`):

- `tools/call` bash with `printf … > /workspace/poc-marker.txt && assets publish /workspace/poc-marker.txt` on `https://gen.pollinations.ai/mcp/computer` (Bearer key, ~0.0002 pollen) returned `https://media.pollinations.ai/35bbb3ff-801b-4831-bf3b-1bb79f3d0530`.
- `GET` that URL: **stored content-type served verbatim** (`text/plain; charset=utf-8` — the `.txt` row of the same `CONTENT_TYPES` map that maps `.html` → `text/html; charset=utf-8`), `Content-Disposition: inline; filename*=UTF-8''poc-marker.txt`, `Cache-Control: public, max-age=31536000, immutable`, `access-control-allow-origin: *`, **no `Content-Security-Policy`, no `X-Content-Type-Options: nosniff`**.
- Authenticated `DELETE` with the same key: **404 Not Found** — no catalog row; the payload class is undeletable through the API exactly as predicted from issue 65.
- Billing: flat 0.0002 for the call (key budget `1.7922652 → 1.7920652`).

The `.html` variant is the identical call with the extension flipped (the only difference is which row of `apps/computer-mcp/src/assets.ts`'s `CONTENT_TYPES` supplies the stored type); it was left for the maintainers' own reproduction to avoid publishing active-content payloads to production storage. Runbook with the exact curl sequence: `download/poc-issue77/LIVE-POC-STEPS-issue77.md`.

## Relationship to filed issues

- **issue 31** (same serve-side gap, HTTP upload path): that path requires an API key; this one requires none. A serve-time allowlist fixes both, but an upload-time fix in the HTTP routes alone would NOT close this RPC path.
- **issue 75** (same RPC write path): its impact was scoped to storage-cost DoS; this adds code-execution-on-origin.
- **issue 76** (same domain topology): supplies the cookie-authority consequence for the media origin.
- **issue 65**: the no-catalog-row property that makes the payload undeletable via the API.

## Fix (minimal)

1. Serve-side (fixes every path at once): enforce a content-type allowlist in `readMedia` — for active types (`text/html`, `image/svg+xml`, anything `text/*` that browsers may render, `application/xhtml+xml`), either rewrite to `application/octet-stream` + `Content-Disposition: attachment`, or serve behind a separate, sandboxed, CSP-locked origin.
2. Upload-side for the RPC: validate `input.contentType` in `uploadUnlistedMedia` against the same allowlist, and drop `html`/`htm`/`svg` from computer-mcp's `CONTENT_TYPES` map (`apps/computer-mcp/src/assets.ts:38-54`) so published assets are inert by construction.
3. Add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'` (or stricter) and `X-Content-Type-Options: nosniff` to `readMedia` responses so stored content can never execute even if a type slips through.
4. Have computer-mcp/ffmpeg-mcp pass `uploadedBy`/`keyType` per issue 75 so published payloads are attributable and cleanable.
