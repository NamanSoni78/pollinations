# Async jobs report success before the payer's billing settlement commits

## Summary

`GenerationCoordinator.alarm()` resolves sync waiters and flips the async job record to `succeeded` **before** awaiting the billing settlement. The settlement contains the D1 payer deduction, the API-key budget reconciliation, the publishable-key pollen consumption, and the Tinybird events — network-bound work that can run for seconds under degradation. If the Durable Object is evicted while the settlement is still draining, the result has already been declared complete (and, for sync waiters, delivered): the payer is never charged. The one-charge-per-generation contract is enforced by *ordering* everywhere else in this class ("claim before the provider call so a restarted alarm fails closed") — except at the moment money actually moves.

Notably, the in-repo test helper `test/helpers/inline-generation-coordinator.ts` already models the intended order — it awaits `completed.settlement` **before** returning the result — while the production coordinator does the opposite.

## Evidence (real worker: gated billing ingest, test D1)

```
1. Owner submits GET /image/<prompt> (Prefer: respond-async)     → 202 {id}
2. Provider call completes; executor writes the media cache
3. Tinybird ingest is held open (simulating a slow settlement)
4. 400 ms later: GET /v1/jobs/<id>                                → {"status":"succeeded"}   ← BUG
   (expected: "pending" until the settlement commits)
5. Gate released → billing event lands exactly once, balance deducted
```

Repro: `test/async-jobs-concurrency.test.ts` case 3 in the verification worktree; assertion `expected 'succeeded' to be 'pending'` against stock `668b6a8`.

## Root cause

`gen.pollinations.ai/src/durable-objects/GenerationCoordinator.ts`, `alarm()`:

```ts
const execution = await executeGeneration(job, this.env);
settlement = execution.settlement;
await this.finish(execution.result, stored.bodyChunks);   // ← marks succeeded, resolves waiters
} finally {
    if (settlement) await settlement;                       // ← billing only drained afterwards
}
```

`executeGeneration` itself already awaits the cache write before returning (`await cacheWrite`), so the cache is durably in place before completion is reported — but the settlement gets no such barrier; it is only joined in the `finally`, after the record and the waiters have already been told the job succeeded.

## Impact

- **Delivered-but-never-billed generations.** A DO eviction (deploy, isolate churn, memory pressure) during the settlement window — which spans at least one D1 write plus telemetry network calls — permanently loses the charge: the record says `succeeded`, the R2 result is downloadable for 30 days, and no alarm retry will run (the record is terminal, so a redelivered alarm sees no job and exits).
- The window is not merely theoretical: the D1 deduction and the Tinybird ingest happen sequentially inside the settlement, and any ingress congestion widens it from milliseconds to seconds.
- The same ordering gap applies to the sync path — waiters receive their (already generated) bytes before the payer's deduction commits.

## Fix

Branch `solution21-settle-billing-before-job-completion` (commit `e61f7791`): after execution, the alarm now awaits the settlement before reporting completion — bounded by `Promise.race([settlement, sleep(2s)])` so a hung or slow settlement can never stall delivery beyond two seconds (telemetry must not hold results hostage), with the `finally` clause still draining the settlement fully either way. Regression test added to `test/async-jobs.test.ts`: with every billing ingest gated open, the job stays `pending`; once released it flips to `succeeded`, the charge lands exactly once, and the balance moves. Full suite 2847 passed, `tsc` clean, biome clean.
