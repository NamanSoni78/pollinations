# One-click full account takeover with the victim's consent bypassed entirely: chaining the `/authorize` `javascript:` redirect (issue 40) with API-level permission minting (issue 59) and `/api/device/approve`'s client-supplied `apiKey` (issue 53) — the single click can be "Decline"

> **STATUS UPDATE 2026-10-22:** upstream `5e07b12a` ("fix(enter): check the authorize redirect scheme before redirecting") fixes the issue-40 link of this chain and is deployed to production (verified in live bundle `authorize-D6Gs4z3h.js`: `BROWSER_SCHEMES` blocklist). The `javascript:` execution vector is closed — reviewed, no bypass found. **The remaining links are still live and independently exploitable**: issue 59 (API accepts `accountPermissions` on any key type), issue 53 (`/api/device/approve` stores the client-supplied `apiKey` verbatim — no XSS required, any script/key holder with a victim session can invoke it), and issue 61 (the same one-click takeover outcome via the consent screen's pre-checked `keys` scope, no redirect involved). The compound-chain risk documented here stands: fixing the XSS alone does not neutralize the takeover chain.

## Summary

Each link in this chain is already filed; this issue documents the **compound exploitation** and the one property that makes it worse than any single link: **the victim's only interaction is a click on "Decline"**. The consent screen is never honored — the user actively refuses and is still compromised.

```
issue 60   POST /api/device/code            unauthenticated, returns device_code/user_code
issue 40   GET /authorize?redirect_url=javascript:<payload>   (no user_code — see below)
           victim clicks Decline → handleDeny assigns window.location.href = the javascript: URL
           → attacker JS now runs in the enter.pollinations.ai origin with the victim's session
issue 59   payload: POST /api/session-token (cookie→sess_) → POST /api/account/keys
           mints a PERMANENT sk_ with accountPermissions ["keys","profile"]
issue 53   payload: POST /api/device/approve {userCode: <attacker's>, apiKey: <minted sk_>}
           — the endpoint stores the client-supplied key string verbatim, no ownership check
           payload: location.href = "https://pollinations.ai" (innocent exit)
attacker   POST /api/device/token → access_token = the victim's admin sk_
```

Two structural details verified in code that make the chain work:

1. **Device mode disables the redirect sink.** `handleAuthorize`/`handleDeny` only assign `window.location.href` in the non-device branch (`frontend/src/components/auth/authorize.tsx:357-435` / `442-469`) — so the attack link must NOT carry `user_code`; instead the payload itself calls `/api/device/approve` for the attacker's pending code. This is exactly what issue 53's missing credential-binding enables: the XSS supplies the `apiKey` string, and the endpoint writes it into KV behind the attacker's `device_code` (`device.ts:185-197`).
2. **No CSP protects the sink.** enter.pollinations.ai serves no `Content-Security-Policy` header (repo-wide scan), so `javascript:` navigation is not blocked by the browser.

The minted key is permanent (no `expiresIn`), carries `account:keys` (the "account admin" permission, `authorize-config.ts:66`), and the delivered token is not a short-lived session token — post-exploitation is identical to issue 61's: enumerate keys, mint unlimited-budget `sk_`s (drain the wallet), revoke the victim's own keys (lockout), read the profile email, register community models.

## Attack

1. `curl -X POST https://enter.pollinations.ai/api/device/code -d '{"client_id":"x"}'` — no auth, no scope needed (the payload mints permissions directly).
2. Send the victim `https://enter.pollinations.ai/authorize?redirect_url=javascript%3A(async()%3D%3E%7B...payload...%7D)()%2F%2F` — the payload (URL-encoded, ~1KB) is: session-token bridge → mint `sk_` with `accountPermissions:["keys","profile"]` → `/api/device/approve` with the attacker's `user_code` → navigate to `https://pollinations.ai`. The trailing `//` makes the `#error=access_denied` fragment that `handleDeny` appends (`authorize.tsx:460-463`) a harmless comment if the browser includes fragments in `javascript:` script source.
3. Victim clicks **Decline** (or Allow — both sinks navigate). The payload executes same-origin with the victim's cookies (`credentials:'include'`), then the tab lands on the marketing homepage as if nothing happened.
4. Attacker polls `POST /api/device/token` and receives the victim's permanent admin `sk_`.

The victim never saw a permission question that was honored, never signed anything, and their only action was a refusal. This is strictly worse than issue 61 (which needs a click on Allow with pre-checked toggles): here the consent screen is decorative.

## Impact

Full account takeover from one link + one click on a **refusal** button: permanent admin key on the victim account, unlimited pollen spend, key lockout, PII (email), community-model registration (composes with issue 58's usage-forgery enrichment). The `javascript:` URL also displays as a blank/odd hostname in the consent UI, and nothing rate-limits the chain end-to-end.

## Fix (minimal, breaks the chain at every link)

1. **issue 40's fix is the primary one**: reject any `redirect_url` scheme other than http(s) in `safeParseUrl`/`validateSearch` (the `parseAppUrl` gate in `return-to-app.tsx` already does this for every other redirect param), and add a CSP without `unsafe-inline` as defense in depth.
2. **issue 53's fix**: `/api/device/approve` must load the `apikey` row by `apiKeyId` and verify ownership + hash, not store the client string.
3. **issue 59's fix**: `createApiKeyForUser` must refuse `accountPermissions` on `publishable` keys, and ideally require an explicit confirmation tier for minting `keys`-permission keys via API at all.
4. Defense in depth: a `Content-Security-Policy` on the enter origin (script-src 'self') kills the `javascript:` execution vector even if the scheme gate regresses.
