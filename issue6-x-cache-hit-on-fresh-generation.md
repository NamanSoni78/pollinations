# x-cache: HIT is returned on the request that generated and billed the asset

## Summary

Every successful response served through the generation coordinator is stamped `X-Cache: HIT` — **including the first-ever request for a unique prompt+seed, which actually ran the provider and was billed for it**. The header can never be `MISS` on these routes, so cache-hit-rate metrics, monitoring, and any client heuristic ("was I served from cache?") are meaningless.

## Live evidence (reproduced against production)

```
$ curl -D- -s "https://gen.pollinations.ai/image/b3-xcache-probe-<unique>?width=256&height=256&seed=991" \
    -H "Authorization: Bearer sk_..." -o img.png
HTTP/1.1 200 OK
x-cache: HIT                                          # first-ever generation of this key
x-usage-completion-image-tokens: 1                    # ...and it was billed

$ curl -D- -s (repeat the identical request)
x-cache: HIT                                          # genuine hit
```

A unique, slow, billed generation reports `HIT` — indistinguishable from the free cached repeat.

## Root cause

`gen.pollinations.ai/src/middleware/generation-deduplication.ts` sets `X-Cache: HIT` unconditionally after `startAndWait` returns, because the response is always re-read from storage — the code cannot distinguish "was already cached" from "was just generated and written". `GenerationOutcome` has only `{cached, failed}`; `executeGeneration` reports `cached` even when it freshly ran the provider and wrote a new cache entry (`execute-generation.ts`).

Note the header is load-bearing: the outer tracking middleware treats `x-cache: HIT` as "not billed here" (`track.ts`, `cacheHit` short-circuit), because billing for coordinated generations happens inside the detached executor. A fix must keep single-billing while making the header truthful.

## Impact

- Cache-hit metrics and dashboards overstate hits (every fresh generation counts as one).
- Users cannot tell a billed generation from a free cached serve; SDKs/agents that branch on the header misbehave.

## Proposed fix

Add a `{status: "generated"}` outcome: the executor reports it when the storage pre-check missed and a fresh cache entry was written; the dedup middleware then sets `X-Cache: MISS` **and** marks the request as already-tracked (`detachedExecutionTracked`) so the outer caller does not emit a second usage row (previously suppressed by the always-HIT header). Genuine cache entries keep `HIT` and the outer tracker keeps recording its free cache-hit row.

**Fix implemented in fork branch:** [`solution6-generation-cache-miss-header`](https://github.com/NamanSoni78/pollinations/tree/solution6-generation-cache-miss-header) — outcome enum + executor + middleware changes, with the stale test expectations updated (first request MISS, repeat HIT, billing unchanged: full suite 2799 tests green).
