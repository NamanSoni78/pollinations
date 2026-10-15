# A stray `stream` flag on media routes bypasses coordination and double-bills identical requests

## Summary

Media routes (`GET /image/:prompt`, `GET /video/:prompt`, `GET /3d/:prompt`, `GET /audio/:text`, and the audio POST routes) never answer with an SSE stream — their responses are files or JSON envelopes. But their query/body schemas are non-strict, so a stray `?stream=true` (or a `stream` field in an audio body) is silently stripped instead of rejected, while `track` still records `streamRequested = true` from the raw request. That flag is exactly what `generation-deduplication` and `generation-cache` check to route a request around the `GenerationCoordinator` — and `stream` is not in the media cache's `EXCLUDED_PARAMS`, so it also becomes part of the cache identity.

The combined effect on one identity:

1. **No single-flight.** Concurrent identical requests each run their own upstream generation and each bills the payer.
2. **Cache fragmentation.** The same request with and without the flag lands on two cache keys, so the identical image is regenerated and rebilled.

The POST `/v1/images/generations` and `/v1/images/edits` routes are immune — `prepareOpenAIImageGeneration`/`prepareImageEditRequest` explicitly reset `streamRequested` ("A passthrough stream flag must not bypass durable media storage") and rebuild the cache body from a whitelist. The GET routes and audio routes never got the same guard.

## Evidence (live, gen.pollinations.ai)

Two probes against production with a paid key, same seed = same identity:

```
P2 (fragmentation):   A: GET /image/<p>?width=512&height=512&seed=777555  → 200 image/jpeg 27803 B (generated)
                      C: GET /image/<p>…&seed=777555&stream=true          → 200 image/jpeg 27803 B
                         x-cache: MISS, 4.5 s regeneration of the byte-identical image (re-billed)

P3 (no single-flight): S1: GET /image/<q>…&seed=777555&stream=true ┐ both fired concurrently
                       S2: GET /image/<q>…&seed=777555&stream=true ┘
                         S1: x-cache MISS, 5.3 s, billed (imgTokens=1)
                         S2: x-cache MISS, 4.4 s, billed (imgTokens=1)
                         → identical bytes generated twice in parallel, paid twice
```

Worker-level repro (`test/media-stream-coordination.test.ts` in the solution branch, real DOs + mocked provider): `expected 2 to be 1` executions, and `expected 'MISS' to be 'HIT'` — both red on stock `main`, green after the fix.

## Root cause

- `middleware/track.ts` — `trackRequest()` derives `streamRequested` from the raw query/body for every event type; nothing ties it to routes that actually stream.
- `middleware/generation-deduplication.ts:165` — `if (c.var.track?.streamRequested === true) return next();` skips the coordinator.
- `middleware/generation-cache.ts:227` — `coordinate = streamRequested !== true` skips single-flight setup.
- `utils/media-cache.ts:17` — `EXCLUDED_PARAMS = ["nofeed", "no-cache", "key"]` keeps `stream` in the key.

## Fix

Branch `solution22-media-stream-flag-bypasses-coordination` (commit `4286056c`):

- `track()` forces `streamRequested = false` for every event type except `generate.text` — the only event type whose responses are SSE streams. One guard covers all current and future media/audio/embedding routes, and telemetry stops reporting media responses as streamed when they were not.
- `stream` joins `nofeed`/`no-cache`/`key` in the media cache `EXCLUDED_PARAMS`, so one identity is one entry regardless of the flag (mirrors the documented `nofeed` rationale).

Regression tests run the real worker with a held-slow provider: two racing identical `?stream=true` requests collapse to one execution, and the stream-flagged form of an already-cached image answers `x-cache: HIT` with a single billed generation. Full suite 2849 passed, `tsc` clean, biome clean.
