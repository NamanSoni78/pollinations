# One-click account takeover via the consent screen's `keys` scope: any unvetted OAuth client can pre-check "Manage keys, agents and models" from a link, receive a victim `sk_` with `account:keys`, and mint unlimited-budget keys — the device-flow variant needs zero attacker infrastructure

## Summary

`CONSENT_PERMISSIONS` includes `keys`, documented in the code as **account admin**:

```ts
// shared/auth/authorize-config.ts:57-75
// - `keys`: account admin; create, list, and revoke API keys, plus My Models
//   access where enabled.
export const CONSENT_PERMISSIONS = ["profile", "usage", "keys", "machines"] as const;
```

The consent screen pre-checks the permission toggles from the **attacker-supplied URL**:

```ts
// enter.pollinations.ai/frontend/src/routes/authorize.tsx:99-101 — scope/permissions pass through
const scope = parseScopeList(search.scope) ?? parseList(search.permissions);

// frontend/src/components/auth/authorize.tsx:102-109 — URL scope → initial toggle state
const keyPermissions = useKeyPermissions(
    getAuthorizeInitialPermissions({ models, budget, expiry, permissions: urlScope }),
);

// shared/auth/authorize-config.ts:95-107
accountPermissions: sanitizeAuthorizeAccountPermissions(permissions),  // pre-checked

// frontend/src/components/keys/account-permissions-input.tsx — the label the victim sees
{ id: "keys", label: "Manage keys, agents and models" }   // checked={value?.includes(id)}
```

On "Allow access", the victim's browser mints an `sk_` on the **victim's** account carrying those permissions and hands it to the app:

```ts
// authorize.tsx:319-355 — handleAuthorize()
const { key, id, expiresIn } = await createKeyWithPermissions({
    prefix: "sk",
    permissions: { allowedModels, pollenBudget, accountPermissions: grantedAccountPermissions, ... },
});

// frontend/src/lib/create-api-key.ts → POST /api/account/keys
// (the same endpoint verified live in issue-59's PoC: accountPermissions on a
//  delivered key are issued with HTTP 200 — no inner guardrail exists)
```

Client registration has **no vetting gate** — in contrast to community models (GitHub allowlist in `shared/auth/github-id-list.ts`):

- `client_id` = any `pk_` the attacker mints on a free account, with `redirectUris` written into their own key metadata (`enter.pollinations.ai/src/routes/app-lookup.ts`: *"any developer can claim any URL by writing it into their key's metadata"*), or
- `client_id` = any `https://` Client ID Metadata Document URL the attacker hosts — **zero Pollinations account required** (`fetchClientMetadata` only enforces https/no-redirects/5KB).

The consent screen displays the app name verbatim from the attacker's key name or metadata `client_name` (`app-lookup.ts:35,101`) — impersonation-ready ("Pollinations Connect", "MCP Server", …).

## Attack — attacker-side only, one victim click (issue-40 class), no XSS, works on mobile

**Variant A — device flow, zero attacker infrastructure (no website, no redirect_uri):**

1. Attacker calls the unauthenticated `POST /api/device/code` with `scope=keys usage profile` (`enter.pollinations.ai/src/routes/device.ts:109-141`, issue 60) and receives `verification_uri_complete` (`https://enter.pollinations.ai/device?user_code=XXXXXX`).
2. Victim opens the link (DM/phishing). `GET /api/device/info` returns the stored scope, which `authorize.tsx:144-167` feeds into the same pre-checked toggles.
3. Victim clicks **"Allow access"** once. The browser mints the admin `sk_` on the victim account and `POST /api/device/approve` parks it in KV bound to the attacker's `device_code` (`device.ts:173-213`).
4. The attacker's CLI polls `POST /api/device/token` and receives `access_token` = the victim's `sk_` with `account:keys` (`device.ts:317-355`).

**Variant B — authorization-code flow (OAuth 2.1, PKCE):**

1. Attacker registers a client (their `pk_` + `redirectUris`, or a hosted metadata document).
2. Victim is sent `https://enter.pollinations.ai/authorize?response_type=code&client_id=<pk_ or https metadata>&redirect_uri=<attacker https>&scope=keys+usage+profile&code_challenge=<S256>&code_challenge_method=S256`.
3. One click on "Allow access" → `POST /api/oauth/code` → redirect with `?code=` → attacker exchanges at `POST /api/oauth/token` (PKCE is satisfied — the attacker owns the verifier) → `access_token` = the victim's admin key (`oauth.ts:150-215`).

**Post-exploitation, all with the single delivered key (chain proven in issue 59):**

- `POST /api/account/keys` → mint a new `sk_` with `pollenBudget: null` (**unlimited**) — drains the victim's wallet through generation spend;
- `GET /api/account/keys` → enumerate every key; `DELETE /api/account/keys/:id` → revoke the victim's real keys (lockout);
- `GET /api/account/profile` → owner email (with `profile` in scope);
- `POST /api/my-models` → register community models (composes with issue 58's usage-forgery enrichment);
- bonus: the consent-minted key binds `originAppKeyId`/`requestedClientId`, so the attacker's app also **earns developer attribution on the victim's future spend** (`AppEarningsRow`).

Secondary pre-fill issue in the same screen: `?budget=<n>` and `?expiry=<days>` from the attacker's URL pre-fill the minted key's budget/expiry (`authorize-config.ts:103-104`), so even without the `keys` scope a crafted link can pre-set a large budget or long expiry that the victim may not notice.

## Why "the user clicked Allow" is not consent here

- The label **"Manage keys, agents and models"** materially undersells account admin: nothing tells the user this grants *creating unlimited-budget keys* (i.e. spending the entire wallet), revoking their own keys, or reading their email;
- the toggles arrive **pre-checked by the requesting party's URL**, inverting the codebase's own stated design — *"Every scope is opt-in — nothing is implicit"* (`authorize-config.ts:57-58`). The app opts in; the user must notice and un-check. Pre-selected sensitive scopes are a recognized OAuth anti-pattern;
- the client is **unvetted by design** (contrast: publishing a community model requires the GitHub allowlist), while the delivered credential equals full account control (issue 59). No OAuth flow on comparable platforms (GitHub `admin:*`, Google `https://www.googleapis.com/auth/cloud-platform`) hands account-admin token-minting to anonymous clients behind a single pre-checked checkbox.

## Fix (minimal)

1. Remove `keys` from `CONSENT_PERMISSIONS` for third-party clients (keep it for the dashboard's own key editor), or gate it behind a typed confirmation ("this app will be able to create unlimited-budget keys") plus an interstitial that requires the app to be verified.
2. Render account-permission toggles **unchecked** regardless of the URL's `scope` — true opt-in per the code's own comment; keep `scope` only to decide *visibility* of the toggle.
3. Cap child keys server-side in `createApiKeyForUser`: a key minted by a `keys`-permission holder must not be able to exceed the *creator key's own* budget/permissions (`shared/auth/api-key-creation.ts`), so a leaked consent key cannot mint unlimited siblings.
4. Require the same GitHub allowlist used for community-model publishing before a `client_id` may request `keys`/`machines`.
5. Treat `budget`/`expiry` URL params as display suggestions only, or clamp them (e.g. budget ≤ account remaining).
