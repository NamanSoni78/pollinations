# A sync cache-hit join can strand a pending async job forever

## Summary

When a synchronous client joins a media generation on the just-written cache (the `cachePresent` fast path of `startAndWait`), the coordinator deletes the claimed job **and cancels its alarm** — but never settles the pending async record, unlike `submit()`'s equivalent cache-hit branch. In the normal case this is harmless because the in-flight alarm handler finishes the record itself. But the whole branch exists precisely for the window where the executor has already written the cache while `finish()` has not run yet — and if the Durable Object was evicted in that window, the cancelled alarm **was the guaranteed retry that would have failed the record closed**. The async owner is left polling a `pending` job that no wake-up will ever finalize, for up to 24 hours, on a generation they may already have been billed for.

## Evidence (real coordinator DO, arranged eviction aftermath)

```
State: JOB_KEY {started: true}, async record {status: "pending", ownerIds: [A]},
       cache object present, retry alarm scheduled (+60s)   // eviction aftermath
1. Sync client calls startAndWait(identical request) → {status: "cached"}   (client is fine)
2. storage.getAlarm()                                        → null           ← BUG
3. coordinator.status(ownerA)                                → {status: "pending"}  ← BUG (forever)
```

Repro: `test/async-jobs-concurrency.test.ts` case 2 in the verification worktree; assertions `expected null not to be null` and record still pending against stock `668b6a8`.

## Root cause

`gen.pollinations.ai/src/durable-objects/GenerationCoordinator.ts`, `startAndWait()`:

```ts
if (cachePresent) {
    await body?.cancel();
    if (stored) {
        await this.clear(stored.bodyChunks, true);   // ← deletes JOB_KEY AND the alarm
    }
    immediate = { status: "cached" };
    return;                                          // ← pending async record untouched
}
```

`submit()`'s cache-present branch does the same `clear(…, true)` but then rewrites the record (`status: "succeeded"`, `completedAt`) and reschedules `setAlarm(now + ASYNC_TTL_MS)`. `startAndWait()` has no equivalent: it relies entirely on the currently-running alarm handler to call `finish()`. That assumption breaks exactly in the scenario the branch handles — the alarm handler that would finish is gone, and Cloudflare's at-least-once alarm retry is what `deleteAlarm()` cancels ("if the alarm handler is currently running, `deleteAlarm()` prevents it from being retried if it fails").

The fail-closed design elsewhere in this class is explicit — *"Claim before the provider call so a restarted alarm fails closed"* — but this path cancels the restart instead of letting it (or an equivalent settlement) happen.

## Impact

- The async submitter's `GET /v1/jobs/:id` returns `pending` with `Retry-After: 5` for up to 24 hours (until `readRecord`'s TTL delete turns it into 404). The result exists in the media cache the whole time, but the owner has no supported way to learn the job completed.
- If the executor's billing settlement committed before the eviction, the owner was charged for a job that reports pending forever — the worst visible state the coordinator can produce (billed, delivered to a joiner, never finalized for the payer).
- Triggering requires a DO eviction in the small window between the executor's cache write and `finish()` plus a sync client hitting the same identity before the alarm retry lands — rare individually, but deploys and isolate churn make it a when-not-if at fleet scale.

## Fix

Branch `solution20-sync-join-settles-pending-job-record` (commit `a8799a27`): after clearing the claimed job on the cache-hit path, `startAndWait()` now calls a new `settleCacheHitRecord(userId)` — mirroring `submit()`'s cache-hit semantics: the record is marked `succeeded` (the cache is the ground truth), the joining user is merged into `ownerIds`, and the TTL alarm is rescheduled. The normal (non-evicted) case converges as before: the in-flight alarm's `finish()` finds a non-pending record, skips its write, and still resolves any registered waiters. Regression test added to `test/generation-coordinator.test.ts` arranging the eviction state directly (claimed job + pending record + cache + scheduled retry) and asserting the join settles the record and leaves a wake-up in place. Full suite 2847 passed, `tsc` clean, biome clean.
