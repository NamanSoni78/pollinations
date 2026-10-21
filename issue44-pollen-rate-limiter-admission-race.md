# PollenRateLimiter admission is a pure read — check-then-consume spans the whole generation, so N concurrent publishable-key requests all pass the same `checkRateLimit` snapshot and the only per-(key,IP) spend throttle never actually throttles a burst

## Summary

The DO that paces spending for publishable keys splits admission from consumption across two RPCs with the entire generation in between:

```ts
// gen.pollinations.ai/src/durable-objects/PollenRateLimiter.ts:39-57
async checkRateLimit(...)  { ... return { allowed: /* read-only math */ }; }  // mutates NOTHING

// :59-76
async consumePollen(...)   { /* the only mutation */ }
```

Admission calls the read (`src/middleware/rate-limit-durable.ts:62-85`, before `next()`); `consumePollen(totalPrice)` fires only **after billing**, when the response/stream completes (`src/middleware/track.ts:462-466`, `src/routes/realtime.ts:868-871`, `src/routes/mcp.ts:215`).

For a `pk_` key the DO (`pk_<keyId>:ip`) is the **only** per-(key,IP) spend throttle (sk_ keys skip it; the edge limiter is 10,000/10s per IP). Because `checkRateLimit` never advances any state, N parallel requests — which the DO does serialize, but serialization is worthless when every call is a pure read against unchanged state — all pass before the first `consumePollen` lands. The window is the full generation duration (minutes for video). The intended pacing ("expensive requests = longer wait", refill `POLLEN_REFILL_PER_HOUR = 1`) is void exactly when it matters: a burst.

## Scenario

1. Script holds any `pk_` key (publishable by design — they ship in public clients).
2. Fires 50 parallel image/video requests with distinct prompts.
3. Every admission passes the same read-only snapshot → all 50 execute at full spend.
4. The 1-pollen-per-hour drip is only enforced sequentially, after the burst already happened.

This compounds the wallet admission gap (issue on wallet reservations): the pk-key path has neither an atomic wallet reservation nor an effective rate limiter under concurrency.

## Fix

Make admission consume. In `checkRateLimit()`, advance `nextAllowedTime` by a provisional estimate in the same DO invocation — a single check-and-increment is atomic under DO input gates — and let `consumePollen(actual)` apply the estimate→actual delta (refund the difference or extend the wait), mirroring the reserve/reconcile pattern the codebase already uses for API-key budgets. The in-repo test comment (`test/rate-limit-durable.test.ts:46`, "without a second admission") shows detached settlement is deliberate; the gap is only that admission itself doesn't reserve.
