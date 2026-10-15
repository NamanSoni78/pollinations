# A stray `stream` field in an audio POST body fragments the cache identity and rebills the identical request

## Summary

`POST /v1/audio/speech` and `POST /v1/audio/speech/with-timestamps` have no JSON body validator. The cache identity for these routes is the **raw request body** — `prepareGenerationRequest` sets `generationCacheBody = normalizedJsonBody(body)`, which strips only the `key` credential. Every other field, including a stray `stream: true`, lands in the identity and therefore in the cache key (the media adapter hashes `generationCacheBody` into `__request_body`; the text adapter uses it as `bodyText`).

But `parseCreateSpeechRequest` (zod) **silently strips `stream`** from the parsed request — the field never reaches any TTS provider and never changes the generated audio. So one logical request spreads across two cache entries:

1. **Sequential fragmentation.** The identical request with and without the flag regenerates the audio and bills the payer again for bytes that were already cached.
2. **No single-flight.** Concurrent identical requests (one plain, one with `stream: true`) each run their own upstream generation, because the flag also marks `track.streamRequested = true`, which `generation-deduplication.ts:165` checks to skip the coordinator — and even with that fixed, the differing body hashes point the two requests at different coordinator jobs.

This is the body-side half of the issue noted in the media stream-flag report: the image generation POST routes rebuild their cache identity from a whitelist (`prepareOpenAIImageGeneration`, `prepareImageEditRequest` — "A passthrough stream flag must not bypass durable media storage"), but the audio speech routes never got the same treatment. OpenAI-compatible clients in streaming mode add `stream: true` to every request body, so Anthropic/OpenAI SDK users hit this by default on TTS calls.

## Evidence (live, gen.pollinations.ai)

Three probes against production with a paid key, same `input`/`voice`/`model` = same identity:

```
P1 (control):  A: {model: openai/tts-1, input, voice: alloy}             -> 200 audio/mpeg, 7.7s, audio-tokens 27 (generated)
               B: {model: openai/tts-1, input, voice: alloy}             -> 200 audio/mpeg, 1.5s, x-cache HIT (cached replay)

P2 (fragments): C: {model: openai/tts-1, input, voice: alloy, stream: true}
                                                                          -> 200 audio/mpeg, 5.2s, x-cache MISS, audio-tokens 27
                                                                          → the identical request was regenerated and billed a second time

P3 (concurrent): plain {input} and stream-flagged {input} fired together -> both MISS, both full generation time,
                                                                          one billed generation each
```

Worker-level repro (`test/audio-post-stream-identity.test.ts` in the solution branch, real DOs + mocked Azure TTS / ElevenLabs + test D1): `expected 'MISS' to be 'HIT'` and `expected 2 to be 1` executions — both red on stock `main`, green after the fix.

## Root cause

- `middleware/generation-cache.ts:163` — `prepareGenerationRequest` derives `generationCacheBody` from the raw JSON body (only `key` stripped) and from `normalizedFormData` for multipart (same).
- `middleware/media-cache.ts:44-52` — the audio adapter hashes `generationCacheBody` into `__request_body`, so any ignored body field becomes part of the cache key.
- `middleware/utils/text-cache.ts:153-169` — the text adapter (used by `/v1/audio/speech/with-timestamps`) hashes the same `generationCacheBody` into the key, and additionally flips the `STREAM_CACHE_VERSION` key part when it sees `bodyObj.stream`.
- `routes/audio.ts` `parseCreateSpeechRequest` — zod validates and strips unknown fields for generation, proving `stream` is inert; nothing reconciles the identity with that whitelist.
- `middleware/track.ts` — `trackRequest` still records `streamRequested = true` from a body `stream` field on audio routes, and `generation-deduplication.ts:165` skips the coordinator for such requests.

## Fix

Branch `solution24-audio-post-stream-identity`:

- `routes/audio.ts` — new `prepareSpeechCacheIdentity` middleware: parses the speech request through the existing zod whitelist (`parseSpeechRequest`), and sets `generationCacheBody` from the validated fields (model resolved to its canonical ID, like the image routes). Runs after `prepareGenerationRequest` on all four chains (public and executor, `/v1/audio/speech` and `/v1/audio/speech/with-timestamps`), so the replayable body stays exactly what the caller sent while the identity only carries the fields that shape the audio.
- `middleware/generation-cache.ts` — `normalizedFormData` now drops `stream` fields like `key`, covering the multipart routes (voice-changer, voice-isolator, transcriptions) where no handler reads `stream` either.
- `middleware/track.ts` — `streamRequested` is forced to `false` for every event type except `generate.text` (the only one whose responses are SSE), so a stray flag cannot bypass durable coordination from the body side.

Regression tests run the real worker: a stream-flagged speech request answers `x-cache: HIT` with a single billed generation, identical concurrent requests across the flag collapse to one upstream execution, and the timestamped route reuses its text-cache entry instead of rerunning ElevenLabs. Full suite green, `tsc` clean, biome clean.
