# A transiently failed API-key budget reconciliation permanently drifts the key's balance

## Summary

Finite-budget API keys (`pollen_balance` set on the key) are charged through a reserve-then-reconcile cycle: `apiKeyBudgetReservation` reserves the estimated price up front (atomically subtracting it from the key budget), and after the generation completes `handleBalanceDeduction` deducts the actual charge from the user's wallet and calls `reconcileApiKeyBalance` to settle the key budget — `adjustment = billed − reserved`.

That reconciliation runs exactly once, after the wallet debit has already committed. When the single D1 `UPDATE` fails transiently (connection blip, internal D1 error), the failure is logged and swallowed (`track-helpers.ts`: *"API key reconciliation failed for {keyId} after committed debit"*) — and **nothing ever corrects it**:

- if `billed < reserved`, the key budget keeps the full reservation: the difference is lost forever;
- if `billed > reserved`, the key budget under-charges by the same amount.

Every affected request permanently drifts the key budget by `|reserved − billed|` with no compensating ledger entry — the key's displayed budget and its enforcement (`pollen_balance >= amount` on the next reservation) disagree with what the key actually spent.

## Evidence (repro through the real billing pipeline)

`test/billing-deduction.test.ts` case *"retries a transiently failed API key budget reconciliation after the committed debit"* (solution branch): key budget 10, reservation 5, actual bill 3, and the key-budget `UPDATE` throws once with a transient D1 error before succeeding on the next attempt.

On stock `main`: the wallet is debited 3 (tier 100 → 97, committed), but the key budget stays at the reserved hold:

```
expected 5 to be 7   // key budget: 10 - 3 = 7 expected, stuck at 10 - 5 (reserved) = 5
```

The 2-Pollen difference is the permanent drift.

## Root cause

`shared/billing/track-helpers.ts` — `reconcileApiKeyBalance()`:

```ts
try {
    const { ok } = await atomicAdjustApiKeyBalance(db, apiKeyId, adjustment);
    ...
} catch (error) {
    log.error("Failed to reconcile API key budget for {keyId}: {error}", ...);
    throw error;   // swallowed by the caller's catch — never retried, never compensated
}
```

The call site (`handleBalanceDeduction`) deliberately swallows the rethrow to preserve the committed wallet debit — the correct choice — but that makes the reconciliation the *last* write anyone attempts for the request. A one-shot failure is final.

## Fix

Branch `solution23-key-budget-reconcile-retry` (commit `f6b57ac5`): `reconcileApiKeyBalance` retries the adjustment once before giving up. Deterministic failures are not retried: an `UPDATE` that affects 0 rows means the key row is gone or its budget was removed, which retrying cannot change — that path still throws immediately. A failure after the retry still propagates exactly as before, preserving the committed user debit.

Red→green regression test added to `test/billing-deduction.test.ts` (19/19 in the suite); full gen suite 2848 passed, `tsc` clean, biome clean.
