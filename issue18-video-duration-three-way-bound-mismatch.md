# Video duration is bounded three different ways: GET ≤30s, POST ≤120s, OpenAPI says ≤120s

## Summary

The same `duration` parameter is validated differently per route. The GET `/image` and `/video` query schemas apply a `superRefine` that rejects anything above **30s**; the POST routes (`/v1/images/generations|edits`, shared `ImageParamsSchema`) allow **1–120s**; and the generated OpenAPI documentation advertises `maximum: 120` for the GET parameter. Three sources of truth, three different answers — a client following the published OpenAPI contract gets rejected by the gateway.

## Evidence (live, against gen.pollinations.ai)

```
GET  /video/a%20cat?model=google/veo-3.1-fast&duration=60   → 400 "Duration above 30 seconds is not supported."
POST /v1/images/generations {"duration": 60, "model": ...}  → passes the gateway (stops only at the paidOnly balance gate: 402)
POST /v1/images/generations {"duration": 121}               → 400 "Too big: expected number to be <=120"   (the shared bound)
GET /image openapi.json duration parameter                  → "maximum: 120"                            (the documented bound)
```

## Root cause

`gen.pollinations.ai/src/schemas/image.ts` — `validateDuration` is a Nova-Reel-era guard: its original message was "Duration above 30 seconds is **only supported by nova-reel**". Nova Reel was retired on 2026-09-30 (#15486/`00f8432`), the message changed to "not supported", but the GET-only cap survived — including through #16587, which removed exactly this class of gen-side provider limits ("providers return their own 4xx"). The POST routes and the schema's own `.meta` description ("Video duration in seconds…") use the documented 1–120s shared bound, with per-model narrowing downstream.

No current model supports more than 15s anyway (`veo`: 4/6/8; `seedance-*`: ≤15; `minimax-h3*`: 5/10/15; `wan`: 2–15; `gemini-omni`: 3–10), and each handles out-of-range input itself: model files clamp (grok 1–15, fal qwen 1–15, seedance 2–12, wan-2.6 snaps to 5/10/15), per-model refinements in `ImageParamsSchema` reject (minimax family), or the provider rejects (veo forwards raw, "let it validate").

## Impact

- GET clients (and any agent driven by `/openapi.json`) sending a documented-valid 31–120s duration get a gateway 400 that contradicts both the POST behavior and the published schema.
- The same request shape succeeds via POST — one parameter, two behaviors depending on the transport.

## Fix

Branch `solution18-duration-get-post-parity` (commit `89416e09`): deletes the `superRefine` (and its function) so GET matches POST and the OpenAPI: the schema's 1–120s bound is the shared public limit, per-model refinements and providers narrow it. Regression test in `test/boolean-param.test.ts` (GET schema accepts `duration=60`, rejects 121/0). No OpenAPI regeneration needed — the docs already said 120. Full suite: 2847 passed, `tsc` clean.
