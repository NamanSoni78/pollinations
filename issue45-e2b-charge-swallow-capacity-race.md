# E2B sandbox lease charges that fail are only logged — the lease proceeds upstream unbilled with no retry and no ledger row; and the sandbox capacity check is count-then-act, so concurrent creates transiently exceed the per-user cap

## Summary

`gen.pollinations.ai/src/routes/e2b.ts` charges sandbox leases after the E2B call succeeds, but a charge failure is swallowed:

```ts
// e2b.ts:222-246
async function charge(c, lease, startTime) {
    let deduction = null;
    try {
        deduction = await handleBalanceDeduction({ ... });
    } catch (error) {
        c.var.log.error("Sandbox lease charge failed: {error}", { ... });
        // ← no retry, no rollback, no kill of the sandbox
    }
    ...
```

The sandbox lease was already created/extended on E2B's side; the user keeps a running, billable-to-the-platform sandbox with **zero Pollen charged and zero ledger row** on any D1 hiccup (transient write error,_BUSY, etc.). The Tinybird event even reports `billedPrice: 0` — the unbilled lease is recorded as free rather than escalated. Every lease extension repeats the pattern (`extendLease`, `:289-316`), so a flapping D1 connection converts an entire session's keep-alive charges to zero.

Second, the same file's admission checks are read-only `requireAccountFunds` preflights (create `:447-527`, extend `:289-316`) — the wallet TOCTOU already filed separately — and the per-user sandbox cap is count-then-act:

```ts
// e2b.ts:194-207 (requireCapacity)
const count = await /* SELECT count of active sandboxes */;
if (count >= CAP) throw ...;
// ← await E2B create — another concurrent create read the same count
```

so N concurrent `POST /e2b/sandboxes` all read `count = 7` (cap 8) and all create — transient cap breach, each lease charging the wallet after the fact.

## Scenario

1. User (or script) starts a sandbox; D1 briefly rejects the charge write (e.g. `D1_ERROR: database is locked`).
2. Log shows `Sandbox lease charge failed`; the sandbox runs anyway; user pays nothing; no ledger row exists to reconcile later.
3. Repeat via `POST /e2b/sandboxes/:id/keep-alive` extensions — each extension that hits a flaky window is another unbilled lease hour.
4. Capacity: fire 5 concurrent creates at count=7 → 12 active sandboxes against a cap of 8.

## Fix

1. Charge via `waitUntil` with a bounded retry (the codebase already has settle-retry patterns in realtime), and if it still fails, either terminate the sandbox or write a pending-charge row for a later reconciliation pass — never silently free.
2. Make `requireCapacity` atomic: a conditional `INSERT ... WHERE (SELECT COUNT(*) ...) < cap`-style guard, or take the count inside the same D1 batch that records the sandbox row.
