# Dead stream flags fork the text cache identity: `?stream=true` on POST routes and a stray body `stream` on /alpha/decisions regenerate, rebill, and skip coordination

## Summary

Two spellings of a stream flag that the route **never honors** still land in the text cache identity and in `track.streamRequested`:

1. **`?stream=true` as a query param on POST routes.** `extractStreamRequested` (`middleware/track.ts:1288`) decides streaming from the **body** field only for POST. But `generateCacheKey` (`utils/text-cache.ts`) folds the query param into the identity **twice**: as a raw filtered query param, and via the `STREAM_CACHE_VERSION` key part that it sets from `url.searchParams.get("stream")` for *all* methods. So `POST /v1/chat/completions?stream=true` with a stream-less body is a different cache entry from the identical request without the query — regenerated and rebilled — while the response stays JSON (the flag does nothing).

2. **A stray body `stream` on `/alpha/decisions`.** `CreateDecisionRequestSchema` has no `stream` field: zod silently strips it, the handler consumes only `{state, questions}`, and the response is always JSON. But the decisions chain never rebuilt its cache identity from the validated body, so the raw body — stray `stream` included — was hashed into the key (flipping `STREAM_CACHE_VERSION`), *and* `extractStreamRequested`'s raw-clone fallback re-read the very field zod had stripped, marking the request as streaming. `generation-deduplication.ts:165` skips the Generation Coordinator for `streamRequested === true`, so identical concurrent decisions **both executed and both billed**.

This is the text-side sibling of the audio POST report (issue 24): the image POST routes rebuild their identity from a whitelist precisely because "a passthrough stream flag must not bypass durable media storage" — the decisions route and the query side of the text routes never got the same treatment.

## Evidence

Live against `gen.pollinations.ai` with a paid key (balance printed between probes; identical bodies, same `respan/span-01-lite` decision):

```
B1 chat POST plain                -> 200 JSON, fresh id, billed
B2 chat POST ?stream=true         -> 200 JSON (NOT SSE — flag ignored), DIFFERENT id, billed again

C1 decisions plain                -> 200 JSON, fresh id, billed
C2 decisions plain (again)        -> 200 JSON, identical id (cached replay)
C3 decisions + body stream: true  -> 200 JSON (flag stripped by zod), DIFFERENT id, billed again

D1/D2 two concurrent identical decisions, both with body stream: true -> both fresh, both billed
     (coordinator skipped — no single-flight)
```

Probe scripts: `scripts/bug-verify-wave7-text-identity.mjs` (chat, decisions, `/v1/responses` both variants).

Worker-level repro (`test/stream-flag-identity.test.ts` in the solution branch, real DOs + mocked upstreams + test D1) — three `expected 2 to be 1` upstream executions on stock `main`:

```
× ignores a stream query flag on POST in the cache identity      (plain vs ?stream=true chat request)
× ignores a stray body stream field on decisions (identity)      (plain vs stream:true decision)
× coordinates identical decisions across the stray stream field  (two held-slow concurrent decisions)
```

All three green after the fix: the flagged request answers `x-cache: HIT` with zero balance delta, the content-type stays JSON, and the concurrent pair collapses to one upstream generation.

## Root cause

- `gen.pollinations.ai/src/utils/text-cache.ts:150` — `let streams = parseBooleanLike(url.searchParams.get("stream")) === true` runs for every method; POST routes decide streaming from the body only. The query param is additionally kept as a raw filtered param, so `?stream=false` also fragments against the flag-less request.
- `gen.pollinations.ai/src/middleware/track.ts` `extractStreamRequested` — for a validated route whose schema strips `stream`, `request.valid("json")` returns an object without the field; the old code then fell back to a raw `request.raw.clone().json()` and re-read the stripped field, so `streamRequested` became true for a request that never streams.
- `gen.pollinations.ai/src/routes/proxy.ts` — the decisions chain has no identity middleware: `textCache` falls back to hashing the raw body, so any unknown field (not just `stream`) forks the identity.

## Fix

Branch `solution26-post-stream-identity` (@ `b2f8ac00`):

- `generateCacheKey` carries stream semantics solely through the `STREAM_CACHE_VERSION` part: `stream` joins `EXCLUDED_PARAMS` (query and body spellings like `?stream=false`, `?stream=1`, `"stream": 1` no longer fragment the entry the flag resolves to), and the query flag only applies to GET-normalized methods, where it is the real switch.
- `extractStreamRequested` trusts a route's validated body: when `request.valid("json")` returns an object, that object is the request's complete semantic truth — a field the schema strips is not part of the request, and the raw-body fallback runs only for routes without a JSON validator.
- The decisions chain gains `prepareValidatedBodyCacheIdentity` (new, in `middleware/generation-cache.ts` beside `prepareGenerationRequest`): it rebuilds `generationCacheBody` from the validated body, so unknown fields cannot fragment the identity. The middleware is documented for routes whose handler consumes nothing beyond the schema — the same rule the image routes already follow.
- `test/helpers/inline-generation-coordinator.ts` now registers its execution synchronously (mirroring the real DO's `blockConcurrencyWhile`), making concurrent joins deterministic instead of a timing race.

Regression tests cover the query flag on chat, the stray body flag on decisions (identity), and the concurrent coordinator join. Full suite green (2875 passed), `tsc` clean, biome clean.
