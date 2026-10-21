# enter's better-auth `trustedOrigins` includes `https://*.pollinations.ai` — a wildcard that covers media.pollinations.ai, a user-content host, so HTML stored there can CSRF cookie-authenticated writes to `/api/auth/*` (up to account deletion)

## Summary

`shared/public-urls.ts:40-42` builds the trusted-origin list from every URL profile:

```ts
export const AUTH_TRUSTED_ORIGINS = Object.values(PUBLIC_URL_PROFILES).flatMap(
    ({ root, wildcard }) => [root, wildcard],
);
// → ["https://pollinations.ai", "https://*.pollinations.ai",
//    "https://myceli.ai", "https://*.myceli.ai"]
```

and `enter.pollinations.ai/src/auth.ts:339-350` feeds it straight into better-auth:

```ts
trustedOrigins: [
    ...AUTH_TRUSTED_ORIGINS,
    "http://localhost:3000",
    ...
],
```

`*.pollinations.ai` matches **every** subdomain — including `media.pollinations.ai`, whose entire purpose is to serve user-uploaded bytes (companion issue: arbitrary `Content-Type` upload served inline there, no CSP). That origin check is the **only** CSRF defense for better-auth's `/api/auth/*` endpoints (the Hono routes under `/api/account/*` are safe because they are Bearer-only).

Why the browser-side layers do not save it, verified against the exact published `better-auth@1.6.30` / `hono@4.10.6` packages:

1. **Cookies are sent.** better-auth 1.6.30 defaults to `sameSite: "lax"`, host-only cookies (no override anywhere in `enter/src/auth.ts`). A page on `media.pollinations.ai` fetching `https://enter.pollinations.ai/api/auth/...` is **same-site** (same registrable domain `pollinations.ai`), so SameSite=Lax does not withhold `__Secure-better-auth.session_token`.
2. **The origin check passes.** better-auth's `validateOrigin` (origin-check middleware) compares the `Origin` header against `trustedOrigins`; `matchesOriginPattern("https://media.pollinations.ai", "https://*.pollinations.ai")` matches the wildcard.
3. **Preflight passes.** enter's Hono CORS is `cors({ origin: "*", allowHeaders: [] })` (`enter/src/index.ts:34-44`); with an empty `allowHeaders` Hono reflects the `Access-Control-Request-Headers` value, so the JSON `Content-Type` preflight from any origin succeeds. (`Access-Control-Allow-Credentials` is absent, so responses can't be *read* — this is a write-only CSRF, not token theft.)

## Attack scenario (end-to-end)

1. Attacker uploads `evil.html` to `media.pollinations.ai` with any key (see companion issue — served inline as `text/html` on that origin, kept alive by periodic refetches).
2. Victim — signed into enter (e.g. just completed a GitHub/Google sign-in — is iframed or navigated to the media URL; no `frame-ancestors` stops the iframe.
3. `evil.html` runs on `media.pollinations.ai`:
   ```js
   fetch("https://enter.pollinations.ai/api/auth/update-user", {
     method: "POST", credentials: "include",
     headers: { "content-type": "application/json" },
     body: JSON.stringify({ name: "pwned", image: "https://evil/x.png" })
   });
   // same effect: /api/auth/delete-user, /api/auth/unlink-account,
   //             /api/auth/sign-out, /api/auth/revoke-sessions
   ```
   The victim's session cookie rides along (same-site), `Origin: https://media.pollinations.ai` passes the wildcard trust, the preflight passes — the mutation executes.
4. **Worst case — `delete-user`:** enter's only guard is the custom freshness hook (`src/auth.ts:222-239`): `DELETE_ACCOUNT_FRESH_SESSION_MS = 10 minutes`. Any victim whose session is younger than 10 minutes — i.e. anyone who *just signed in*, exactly the population most likely to be phished to a fresh "welcome" link — gets their entire account cascade-deleted (keys, Pollen balances, agents, connected accounts) by one background request they never see.

The codebase already recognizes that `pollinations.ai` hosts serve user uploads in the *neighboring* trust decision — `enter/src/services/client-metadata.ts:39-42` refuses `pollinations.ai`/`myceli.ai` hosts as OAuth Client-ID Metadata Documents precisely because they serve user uploads. The same reasoning was just never applied to `trustedOrigins`.

## Fix

Stop wildcard-trusting subdomains that serve user-controlled bytes:

- Replace the wildcard profile entries with an explicit first-party list of the origins that actually need to call `/api/auth/*` with cookies: `enter`, `gen`, the observability/KPI/economics dashboards, and the apex `pollinations.ai` — not `media`, not any other user-content host.
- Belt-and-braces (independent of the origin list): add `X-Frame-Options: DENY` / `frame-ancestors 'none'` on media's public GET responses, and fix the companion upload issue so no active content can be hosted on the subdomain in the first place.
- Consider requiring a fresh-session re-auth gesture (not just age) for `delete-user`, since "signed in within 10 minutes" is exactly what a phishing page can arrange.

## Verification status

Static end-to-end: upload path accepts `text/html` (read all three ingestion paths); serve path returns it inline with no CSP/nosniff (read `readMedia`); better-auth 1.6.30 origin-check wildcard match + Lax same-site cookie behavior verified against the published package internals; Hono CORS header reflection verified. Not runtime-exploited (no write access to prod).
