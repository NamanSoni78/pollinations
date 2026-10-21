# Editing an API key's budget is an absolute SET that clobbers in-flight reservations — a mid-flight edit re-inflates a key's spend cap beyond what the owner set (or pushes it negative when lowering), because gen's reserve/adjust writes are relative while enter's PATCH is not

## Summary

gen reserves API-key budget with **relative, conditional** writes:

```ts
// shared/billing/deduction.ts:107-124  atomicReserveApiKeyBalance
UPDATE api_key SET pollen_balance = ROUND(pollen_balance - ${amount}, 8)
WHERE id = ${apiKeyId} AND pollen_balance >= ${amount}

// :137-144  atomicAdjustApiKeyBalance — same shape, ± delta
```

enter's key editor writes the budget as an **absolute** value:

```ts
// enter.pollinations.ai/src/routes/account.ts:1812-1836 (PATCH /api/account/keys/:id)
pollenBalance: pollenBudget,   // SET pollen_balance = <absolute>
```

The two compose badly whenever an edit lands while a generation is in flight:

1. Key starts at budget 10. A video request reserves 2 → `pollen_balance = 8` (reservation).
2. The owner PATCHes the budget down to 5 (fencing an agent they no longer trust): `SET pollen_balance = 5`.
3. The video finishes; actual billed = 3; settlement adjusts `billed − reserved = 1`: `pollen_balance = 5 − 1 = 4`. So far so good — but the reservation *system's* ledger just lost 2 pollen of accounting: the final cap now permits spending 5 more, i.e. total spend = reservation era 2 + post-edit 5 = **7 > the owner's set 5**.
4. Symmetrically, an owner *raising* the budget mid-flight then settling can end below the new cap; and lowering to a value below the in-flight reservation plus writes can drive the key negative — the exact failure the conditional reservation was built to prevent.

The wallet charge itself is unaffected — this is per-key **cap integrity**: the feature owners use to fence third-party keys/agents to a fixed spend.

## Fix

One of:
1. Make budget edits delta-aware: reject or serialize while in-flight reservations exist (enter can query the same reservation state gen reconciles against), then apply.
2. Apply budget edits as `SET pollen_balance = ROUND(${budget} - (reserved outstanding), 8)` — requires the reservation outstanding to be readable, which the adjust-path already tracks.
3. Move per-key spend accounting to a ledger table (append-only reserves/adjusts, budget as a config value, effective balance = budget − sum(ledger)) — removes the class entirely; the wallet side already works this way via transactions.

Minimal viable: option 1 (a clear 409 "key has in-flight usage, try again" is honest and cheap), documented in the dashboard.
