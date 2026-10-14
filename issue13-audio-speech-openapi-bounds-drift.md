# POST /v1/audio/speech documented bounds contradict the enforced schema (duration max 300 vs 380, seconds min 1 vs 0.5)

## Summary

The hand-written OpenAPI request body for `POST /v1/audio/speech` documents `duration` with `maximum: 300` and `seconds` with `minimum: 1`. The zod schema that actually validates the request (`CreateSpeechRequestSchema`) enforces **0.5–380 for both**. OpenAPI-generated clients therefore pre-reject requests the API happily serves (duration 301–380), and treat values the API rejects at 0.5 as documentable. Every other speech surface (GET `/audio/:prompt`, the schema-driven docs) is generated from the same zod bounds and is correct — only the hand-maintained POST body drifted.

## Live evidence (reproduced against production)

```
$ curl -s https://gen.pollinations.ai/openapi.json | jq '.paths["/v1/audio/speech"].post.requestBody.content["application/json"].schema.properties | {duration, seconds}'
{ "duration": { "type": "number", "minimum": 0.5, "maximum": 300 },
  "seconds":  { "type": "number", "minimum": 1,   "maximum": 380 } }

# enforcement probes (microsoft/mai-voice-2.1 rejects speed≠1 AFTER zod, BEFORE billing → zero-cost):

$ POST duration=350 + speed=1.5 → 400 "The speed parameter is only supported by openai/tts-1 and openai/tts-1-hd"
                                   # duration 350 passed zod — docs say max 300
$ POST duration=380 + speed=1.5 → 400 speed error    # 380 passes (boundary)
$ POST duration=381           → 400 "duration: Too big: expected number to be <=380"
$ POST seconds=0.7 + speed=1.5 → 400 speed error       # seconds 0.7 passed zod — docs say min 1
$ POST seconds=0.3            → 400 "seconds: Too small: expected number to be >=0.5"
```

## Root cause

`gen.pollinations.ai/src/routes/audio.ts`:

- enforced: `CreateSpeechRequestSchema` (line ~99-107) — `duration: z.number().min(0.5).max(380)`, `seconds: z.number().min(0.5).max(380)`
- documented: hand-written OpenAPI body (line ~4419-4429) — `duration: { minimum: 0.5, maximum: 300 }`, `seconds: { minimum: 1, maximum: 380 }`

The `max(380)` values match the model registry's broadest music/SFX range (`stability-audio` 1–380, `lyria` allowed durations up to 380); the hand-written numbers were simply never updated when the schema bounds were set.

## Impact

- OpenAPI code generators (openapi-generator, orval, Speakeasy…) emit client-side validation that rejects valid requests: any `duration` in 301–380 and any `seconds` in 0.5–0.99 fails before the request is even sent.
- The published spec misleads human integrators about the contract; the same wrong pair is mirrored in `APIDOCS.md`'s request-body table.

## Fix

Branch `solution13-audio-openapi-bounds` (commit `fd27a1a`): the hand-written body now says `0.5–380` for both fields; the `APIDOCS.md` table row is updated to match; a new test (`test/audio/speechOpenapiBounds.test.ts`) pins the documented bounds to the enforced values so the hand-maintained body cannot drift from the schema again. Full suite: 2797 passed.
