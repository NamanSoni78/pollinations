# issue 70 — Child-key privilege & budget escalation on `POST/PATCH /api/account/keys`: a `keys`-scoped key mints full-scope children (incl. `machines` + PII `profile`), self-patches its own scopes, and a 0.01-pollen-capped key mints **unlimited-budget** children

**Severity: high (violates the consent screen's core promise "every scope is opt-in — nothing is implicit": an app granted only key management silently obtains account-wide PII reads, full balance visibility, and sandbox spending; budget-capped grants are bypassed by minting uncapped children — all with zero further user interaction)**
**Status: LIVE in production, verified 2026-10-23 end-to-end (keys-only child minted a full-permission grandchild that read the account's name+email; capped child minted an unlimited grandchild; both cleaned up)**

## Summary

The account API lets an **API-key caller** create and update keys, but never checks that the new key's grants are a **subset of the calling key's own grants**. `questPollenOnly` is subset-enforced on both create and update ("A child key can't spend what its creator can't" / "A Quest Pollen only key can't lift that limit") — `accountPermissions` and `pollenBudget` are not. The only gate on both endpoints is `requireAccountPermission(callerKey, "keys")`, and `sanitizeAuthorizeAccountPermissions` (shared/auth/authorize-config.ts) merely filters the request to the four valid scope names; it does not compare them with the caller's scopes.

Where it happens (current `main`, `31256700`):

- `enter.pollinations.ai/src/routes/account.ts:1762-1846` — `POST /keys`: `requireAccountPermission(c.var.auth.apiKey, "keys")`, then the body's `accountPermissions` and `pollenBudget` flow straight into `createApiKeyForUser`. No subset check, no budget ceiling.
- `enter.pollinations.ai/src/routes/account.ts:1847-1970` — `PATCH /keys/:id`: same gate; `accountPermissions` is applied via `sanitizeAuthorizeAccountPermissions` with no comparison to the caller's scopes, and `pollenBudget` is written as-is. There is also **no self-modification check** (unlike DELETE at `:2041-2046`), so a key can patch **itself**.
- `shared/auth/api-key-creation.ts` (`createApiKeyForUser`): `safeAccountPerms = sanitizeAuthorizeAccountPermissions(accountPermissions)` — the only transformation; `effectivePollenBudget = isPublishable ? 0 : pollenBudget` — an omitted/`null` budget means **unlimited**.
- Scope semantics (`shared/auth/authorize-config.ts`, `CONSENT_PERMISSIONS`): `profile` = read account **name and email** (PII); `usage` = full account balance + account-wide usage; `keys` = create/list/revoke keys; `machines` = create and run **hosted sandboxes** (billed to the account's pollen).

The consent screen is built around these being separate opt-ins (frontend `/authorize` + device flow show per-scope checkboxes; the authorize-config comment reads "Every scope is opt-in — nothing is implicit"). This endpoint pair silently collapses all four into "keys".

Live verification (attacker = the app's key; every step authorized with the app's own `sk_`):

```
P  = pre-existing test key (account:["keys","usage","profile","machines"])   # setup only
1) POST /account/keys  {"name":"poc-w20-child-keys-only","accountPermissions":["keys"]}
   -> 200  K2 perms: {"account":["keys"]}                                    # the ONLY thing a
                                                                              # "manage my keys" app has
2) POST /account/keys (Bearer K2)  {"name":"poc-w20-grandchild-escalated",
                                    "accountPermissions":["keys","machines","usage","profile"]}
   -> 200  K3 perms: {"account":["keys","machines","usage","profile"]}        # scopes K2 never had

   GET /account/profile with K3 -> 200 {"name":"07mrbeastofficial","email":"07mrbeastofficial@gmail.com"}
   GET /account/profile with K2 -> 200 {"name":null,"email":null}            # PII gate works —
                                                                              # until it's escalated away

3) PATCH /account/keys/<K2-id> (Bearer K2)  {"accountPermissions":["keys","machines"]}
   -> 200  K2 perms after SELF-patch: {"account":["keys","machines"]}         # a key editing itself

4) POST /account/keys {"name":"poc-w20-budget-capped","pollenBudget":0.01,"accountPermissions":["keys"]}
   -> 200  child pollenBudget: 0.01                                          # a consent-style capped grant
   POST /account/keys (Bearer that child)  {"name":"poc-w20-unlimited-grandchild"}
   -> 200  grandchild pollenBudget: null                                     # null = unlimited —
                                                                              # the 0.01 cap did not propagate
```

All demo keys were revoked in cleanup.

## Attack (attacker = app developer; one consent click from the victim, then fully hands-off)

1. Attacker ships any app using Pollinations' OAuth/app sign-in (pk_ client) or shares a CLI setup that walks the user through the device flow. The user grants **only** the `keys` scope — the least alarming checkbox ("manage my API keys") — with the default small budget (consent defaults: 5 pollen / 7 days).
2. The granted `sk_` has `account:["keys"]` and `pollenBudget: 5`. From that moment the attacker never needs the user again:
   - `POST /api/account/keys` with `accountPermissions:["keys","machines","usage","profile"]` → a full-scope key.
   - Or `PATCH` the granted key itself to add the scopes (no new key even appears in the dashboard list to raise suspicion).
   - Or mint a child with **no** `pollenBudget` → unlimited spend envelope (spends the account's entire tier + pack balance, not the consented 5).
3. Impact with the escalated scopes, no further interaction:
   - `profile` — exfiltrate the account's **name and email** (verified above).
   - `usage` — full balance and account-wide usage visibility (privacy + competitive intel).
   - `machines` — create and run **hosted E2B/Azure sandboxes billed to the victim's pollen** (`requireSandboxAccess` checks exactly `account:machines`), the direct monetization path.
   - `keys` (already granted) — revoke the victim's legitimate keys (denial of service), or silently swap in attacker-chosen key configurations.
4. The same missing-subset check also breaks the OAuth-app trust boundary in reverse: any key with `keys` can edit **every other key the user owns** (`referenceId = user.id` ownership passes for all of them), including adding scopes to an existing long-lived key the user relies on.

## Fix (minimal)

Enforce downward-closed grants at the single choke point where the caller is an API key (session/owner callers legitimately have full rights):

- In `POST /keys` and `PATCH /keys/:id` (routes/account.ts), when `c.var.auth.apiKey` is set: intersect the requested `accountPermissions` with the caller's own `account` scopes (`hasAccountPermission` model already exists in shared/auth/account-permissions.ts), and cap `pollenBudget` at the caller's remaining budget (or reject child budgets that are absent when the caller itself is capped).
- Additionally: refuse `PATCH` of the key used to authenticate the request (mirror the DELETE self-check at `:2041-2046`) — or at minimum refuse scope/budget changes on it.
- `questPollenOnly` already follows the subset rule on both endpoints (account.ts:1819-1821, :1905-1913) — this is the same pattern one level up.

Cross-references: issue 61 (device-flow consent grants the `keys` scope by default — the on-ramp that makes a "keys-only" grant common in the wild), issue 59/53 (key-minting trust), issue 65 (`pk_` keys upload auth — unrelated but same "type-blind" family). The sandbox billing sink for `machines` is `enter.pollinations.ai/src/routes/e2b.ts` / `azure-sandboxes.ts` (`requireSandboxAccess`).
