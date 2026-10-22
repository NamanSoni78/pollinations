# issue 66 — x402 key purchases: the payment signature is a bearer credential for the funded key; cross-pack replay 500s with the raw internal error

**Severity: low-medium (secret-handling + robustness on a money route)**
**Status: code-verified on `origin/main` 432d5e54 (2026-10-22)**

## Summary

Three weaknesses in `enter.pollinations.ai/src/routes/x402-keys.ts` + `src/services/x402-key-purchases.ts`:

1. **Replay returns the funded plaintext `sk_` to anyone holding the `payment-signature` header** — `x402-keys.ts:99-124`: after Weft settles a payment once, every later request presenting the same signature hits the `getPurchase` lookup and is handed `{id, key, pollen}` — the **funded secret key** — with no payer binding, no freshness window, and no re-verification. The purchase id is just `SHA-256(stableStringify(payload))` (`x402-key-purchases.ts:53-67`), and the signature is a long-lived settlement receipt, not a capability scoped to the buyer. Anyone who observes the header once (reverse proxy logs, shared machines, a reposted curl) can redeem the funded key forever.
2. **Cross-pack replay = unhandled 500 that echoes the internal error message** — the replay branch never checks `previous.pack_key === purchaseKey` before `preparePurchase`, which throws `Payment already belongs to another purchase` (`x402-key-purchases.ts:90-92`). The route has no `try/catch` for this, and `shared/error.ts:382` wraps `error.message` into the response body — an unauthenticated 500 leaking internal wording to anyone replaying a valid signature against a different pack path.
3. **Unthrottled unauthenticated D1 work per request** — every `POST/GET /api/x402/keys/:packKey` performs a holding-user select (`x402-keys.ts:88-97`) plus `getPurchase` when a signature is present, and constructs a fresh payment middleware per request (`x402-keys.ts:127-178`) — no rate limit (compare the quest-check KV throttle). Unauthenticated D1 quota burn on a route mounted without auth (`src/frontend-api.ts:20`).

Also worth noting for key hygiene: the at-rest encryption of purchased keys is derived from `BETTER_AUTH_SECRET` (`x402-key-purchases.ts:30-43`) — rotating the auth secret silently bricks every outstanding prepaid key, and a leak of that one shared secret (already used for sessions, sess_ minting and agent-run tokens) decrypts the entire prepaid-key table.

## Attack

1. **Signature theft = key theft.** A single captured `payment-signature` header (from logs of any intermediary, a copied curl, a shared terminal) redeems the live `sk_` at any later time via `POST /api/x402/keys/<packKey>` with that header — response body includes the plaintext funded key.
2. **Error-oracle 500:** replay that same signature against a *different* pack path → `500 {"error":{"message":"Payment already belongs to another purchase"}}` (unauthenticated, raw internal message).
3. **Quota burn:** unauthenticated loop against `/api/x402/keys/<any pack>` — 2 D1 reads per call, no limiter.

## Fix (minimal)

- Bind the replay response to the buyer: on first redemption, capture a buyer-supplied secret (e.g. a client-generated pre-image committed alongside the purchase) and require it on replay; or at minimum document the header as a bearer credential and add a short replay window.
- In the replay branch, compare `previous.pack_key !== purchaseKey` → `400` instead of falling into `preparePurchase`; wrap the branch in the route's error handling so internal `Error.message` never reaches the body.
- Add the same KV/edge throttle used elsewhere (e.g. `account.ts` quest-check) for unauthenticated calls.
- Consider a dedicated `X402_KEY_ENCRYPTION_SECRET` binding for `encrypted_key` so auth-secret rotation can't strand funds.
