# Publishable `pk_` keys can carry account permissions — a browser-public key becomes full account takeover

## Summary

The platform invariant is that publishable keys are safe to embed in frontends (pollen budget 0 is enforced), but the server never rejects **account permissions** on a publishable key:

```ts
// shared/auth/api-key-creation.ts:233-256 — createApiKeyForUser()
const isPublishable = type === "publishable";
if (isPublishable && pollenBudget != null && pollenBudget !== 0) {
    throw new HTTPException(400, { message: "Publishable keys must have a pollen budget of 0" });  // enforced
}
...
const safeAccountPerms = sanitizeAuthorizeAccountPermissions(accountPermissions);
if (safeAccountPerms && safeAccountPerms.length > 0) {
    permissions.account = safeAccountPerms;    // ← NOT gated on isPublishable
}
```

`POST /account/keys` (`enter.pollinations.ai/src/routes/account.ts:1762-1845`) and `PATCH /keys/:id` (1847+) pass `accountPermissions` through `CreateKeySchema`/`UpdateKeySchema` with no `type !== "publishable"` check. And a `pk_` authenticates to every account route exactly like an `sk_`:

```ts
// shared/auth/api-key.ts:225-258 — authenticateApiKeyRequest()
const keyResult = await client.api.verifyApiKey({ body: { key: rawApiKey } });
// better-auth verifyApiKey has no prefix restriction → pk_ keys authenticate
```

`requireAccountPermission(apiKey, "keys")` then passes whenever `apiKey.permissions.account` contains `"keys"`. The docstring for POST /account/keys even suggests `accountPermissions` without warning that this must never be combined with `type: "publishable"`.

## Impact

1. **Account takeover:** A developer creates a publishable app key (for BYOP/authorize — designed to be embedded in a public frontend) and grants it `accountPermissions: ["keys"]` (API accepts it silently; nothing in the server rejects the combination). Every visitor of that frontend extracts the `pk_` and then operates as the owner's account admin: `GET /api/account/keys` (lists every key + metadata), **`POST /api/account/keys` (mints a new secret key with an unlimited pollen budget)**, `DELETE /api/account/keys/:id`, community models, integrations. The unlimited `sk_` drains the owner's entire pollen.
2. **Owner PII without any permission:** `GET /api/device/userinfo` and `GET /api/oauth/userinfo` (`enter.pollinations.ai/src/routes/device.ts:373-399`, `oauth.ts:222-226`) authenticate any `pk_` (public by design) and return `sub` (internal account id), `picture`, `preferred_username` — and with `account:profile`, the owner's **name + email**. Anyone can resolve any embedded pk_ to its owner's identity.

Everything else about pk_ keys is locked down server-side (budget forced to 0, redirect URIs publishable-only, earnings flag publishable-only) — this is the one unenforced invariant, and it is the dangerous one.

## Fix (minimal)

1. Reject non-empty `accountPermissions` when `type === "publishable"` in `CreateKeySchema` + `UpdateKeySchema` (server-side, not just UI), mirroring the existing pollen-budget guard:
   ```ts
   if (isPublishable && safeAccountPerms?.length) {
       throw new HTTPException(400, { message: "Publishable keys cannot have account permissions" });
   }
   ```
2. Strip any existing `permissions.account` from `pk_` rows in a migration (they can only be misconfigurations).
3. Belt & suspenders: in `requireAccountPermission` (or `loadActiveApiKeyAuthResult`), treat `prefix === "pk"` keys as having no account permissions regardless of stored rows.
4. Restrict `/api/device/userinfo` + `/api/oauth/userinfo` identity fields to `sk_` keys (or an explicit grant).
