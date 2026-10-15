# Retrying a failed async job steals the record from its original owners

## Summary

`Prefer: respond-async` jobs are keyed by the request's cache identity, so every account that submits the *identical* request shares one job id and one `AsyncJobRecord`. When a previous run has terminated (e.g. it failed) and **another account retries the identical request**, `GenerationCoordinator.submit()` replaces the shared record with `ownerIds = [retrying user]` only — the accounts that submitted the original run lose access to their job and get `404 Job not found`, hours before the documented 24-hour expiry. Retry-after-failure is the natural client pattern, which makes this the most common multi-client interleaving on the jobs API.

This contradicts both the code's own contract — `AsyncJobRecord.ownerIds` is documented as *"All accounts that actually submitted this identical request"* — and the invariant the existing test asserts for the in-flight case (*"A second account can submit the identical request, but cannot take away the original account's access"*), which today only holds while the run is pending.

## Evidence (real worker: miniflare DOs, mocked provider, test D1)

```
1. Owner A submits GET /image/<prompt> (Prefer: respond-async)   → 202 {id}
2. Provider fails → job record: status=failed, ownerIds=[A]; A polls → 200 failed
3. User B submits the IDENTICAL request                          → 202 {same id}
4. B's run executes under B's auth and B is billed once          → executions=2, billed=1 (B)
5. A polls GET /v1/jobs/<id>                                     → 404 {"error":"Job not found"}   ← BUG
   (expected: 200, status=succeeded — A submitted this identical request)
```

Repro: `test/async-jobs-concurrency.test.ts` case 1 in the verification worktree; assertion `expected 404 to be 200` against stock `668b6a8`.

## Root cause

`gen.pollinations.ai/src/durable-objects/GenerationCoordinator.ts`, `submit()`:

```ts
const sameRun = stored && previous?.status === "pending";
const ownerIds =
    sameRun || cachePresent
        ? [...new Set([...(previous?.ownerIds ?? []), job.auth.user.id])]  // merge
        : [job.auth.user.id];                                              // replace
```

The merge branch covers join-while-pending and cache-present joins. The replace branch is reached when the previous record is terminal **and** no cache exists — exactly the state a failed run leaves behind (failed runs never write the cache). The new submitter's record overwrites the previous owners, and because the record is keyed by cache identity (one per identical request), the same `/v1/jobs/:id` now answers only to the latest submitter.

## Impact

- Any failed async job becomes unreadable for its original submitters as soon as anyone — including the same user from another key, or a different account — retries the identical request. The 24-hour readability promise in the API docs ("the job record expires 24 hours after completion") is broken by third-party activity.
- The original owner can no longer distinguish "my job failed" from "my job vanished": the poll that is supposed to surface the failure instead returns 404, which client retry loops typically treat as a dead id.

## Fix

Branch `solution19-async-job-keeps-previous-owners` (commit `1898b703`): `submit()` now merges `previous.ownerIds` unconditionally — every account that submitted the identical request keeps reading the shared record, matching the `AsyncJobRecord` type contract; the record still describes the latest run (`createdAt` reset on a new run, `status` pending → succeeded/failed as it settles). Regression test added to `test/async-jobs.test.ts`: a failed job retried by another account stays readable by the original owner (200/succeeded), the retry executes and is billed once to the retrying account only, and the original owner's balance is untouched. Full suite 2847 passed, `tsc` clean, biome clean.
