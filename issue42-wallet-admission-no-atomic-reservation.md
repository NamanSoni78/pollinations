# User wallets have no atomic admission control — the preflight is a read-only SELECT, so N concurrent requests sharing one wallet all pass on the same snapshot and settle into negative tier/pack balances while the platform funds the upstream compute; API-key budgets got a conditional atomic reservation (`atomicReserveApiKeyBalance`) but user wallets never did

## Summary

The generation admission check for user wallets is a plain read:

```ts
// gen.pollinations.ai/src/utils/generation-access.ts:30-61
const userBalance = await requireFunds(
    { var: vars, env },
    estimatedCost,
    () => balance.getBalance(userId),   // ← SELECT
    isPaidOnly,
);
```

`requireFunds` (`src/utils/refusals.ts:90-111`) is an in-memory comparison against the **average historical cost** of the model — no write, no lock, no reservation. Settlement then runs the unconditional ladder in `shared/billing/deduction.ts:60-92`:

```sql
WHEN COALESCE(tier_balance, 0) >= ${amount} THEN 'tier'
WHEN COALESCE(pack_balance, 0) > 0 THEN 'pack'    -- pack can go negative
ELSE 'tier'                                         -- tier debt fallthrough
```

Contrast the pattern that exists **only** for API-key budgets (`shared/billing/deduction.ts:107-124`):

```sql
UPDATE api_key SET pollen_balance = ROUND(pollen_balance - ${amount}, 8)
WHERE id = ${apiKeyId} AND pollen_balance >= ${amount}   -- conditional, atomic
```

exercised by `test/billing-deduction.test.ts:242` ("admits only as many concurrent API key reservations as the budget covers"). No equivalent guards the `user.tier_balance`/`pack_balance` columns.

## Attack interleaving (verified: no per-user lock, DO, or serialization anywhere on the wallet path)

1. Account holds `tierBalance = 0.5` (one quest reward). Preflight passes if any single bucket covers the *average* cost (e.g. 0.3–0.5 for video models).
2. Fire **N concurrent requests** with distinct prompts (dedup doesn't join them; edge rate limit is 10,000/10s per IP; `sk_` keys skip the Pollen rate limiter; `stream:true` bypasses coordination per the already-filed issue22).
3. All N preflights read the same balance snapshot → all pass → all N generations execute → the platform pays upstream for all N.
4. Settlement runs N unconditional ladder deductions: final `tier = 0.5 − N×cost` (negative), pack possibly negative too. The account is only refused once **both** buckets are ≤ 0 — after the damage. "Collection" is soft (402s until the next top-up/quest).

Even a **single sequential request** overdraws when actual usage exceeds the average-cost estimate (streamed text bills after the stream drains), but concurrency multiplies the exposure by N per burst, repeatable per fresh account. With 1 pollen ≈ $1 and video models averaging a few tenths to several pollen, a burst of tens of requests costs the platform real provider spend with ~0.5 pollen of cover.

## Fix

Mirror the proven key-budget reservation at the wallet layer: at admission, atomically reserve the estimate with a conditional write —

```sql
UPDATE user SET tier_balance = ROUND(tier_balance - ${est}, 8)
WHERE id = ${userId}
  AND (COALESCE(tier_balance,0) + COALESCE(pack_balance,0)) >= ${est}
```

fail closed with 402 on 0 rows (honoring `paidOnly`/`questPollenOnly` bucket rules), carry the reservation through the existing snapshot plumbing (`balanceCheckResult` / `apiKeyBudgetEstimate`, `GenerationJobHead`), and reconcile `actual − reserved` at settlement with an `atomicAdjustApiKeyBalance`-style write. The DO input-gate change is not required — the conditional UPDATE is atomic in D1, which is exactly why the key-budget version works under the same concurrency.
