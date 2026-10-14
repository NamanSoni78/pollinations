# Image endpoints accept zero and negative dimensions — leaked backend errors and silent remaps

## Summary

`width=0&height=0` passes GET validation (`.nonnegative()` allows 0) and negative sizes parse on POST (`size="-100x-50"` flows through `Number.isInteger`). Both reach providers, producing **three different inconsistent behaviors**: leaked raw backend validation errors, silent remaps to defaults, or hard backend failures. The gateway should reject them with a clean 400.

## Live evidence (reproduced against production)

```
$ curl "https://gen.pollinations.ai/image/b1-dims-probe?width=0&height=0&seed=11" -H "Authorization: Bearer sk_..."
→ HTTP 400, body leaks the provider's pydantic internals:
  {"message":"{\"detail\":[{\"type\":\"greater_than\",\"loc\":[\"body\",\"image_size\",\"ImageSize\",\"width\"],
   \"msg\":\"Input should be greater than 0\",\"input\":0,...}"}   # from zimage backend

$ curl -X POST https://gen.pollinations.ai/v1/images/generations \
    -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
    -d '{"prompt":"b1-dims-probe","size":"-100x-50","seed":11}'
→ HTTP 400, body leaks the upstream host and body:
  {"message":"Image backend rejected request with status 400",
   "details":{"upstreamHost":"flux-vast-04.pollinations.ai",
               "upstreamBody":"{\"detail\":\"Dimensions too small: -100x-50. Minimum allowed is 64x64\"}"}}
```

Behavior by backend for the same invalid input:
- self-hosted models: forward raw values → leaked pydantic/flux errors (above)
- `wanImageModel`, `qwenImageModel`, `fluxKleinModel`, `prunaModel`, `ideogramReplicateModel`: `safeParams.width || 1024` silently remaps 0 → 1024
- `gpt-image`: clamps 0 → 16 → 816x816

## Root cause

- `gen.pollinations.ai/src/schemas/image.ts` — GET `width`/`height` use `.int().nonnegative()`, so **0 passes**.
- `gen.pollinations.ai/src/image/params.ts` — `sanitizedSideLength` is `z.int().optional()` with **no minimum at all**, so POST-parsed negatives (`size="-100x-50"`) flow to model dispatch.

## Impact

- Ugly, confusing 400s that leak provider internals (hosts, pydantic traces) to API consumers.
- Same invalid request produces three different outcomes depending on which backend serves it.
- Wasted provider round-trips for guaranteed-failing requests.

## Proposed fix

Enforce a 16px floor — the smallest side any backend produces (gpt-image clamps up from 16) — in both the GET query schema and the shared `sanitizedSideLength`. Model-specific minimums (64, 256, 768…) keep producing their own clean model-level errors.

**Fix implemented in fork branch:** [`solution2-image-dimension-validation`](https://github.com/NamanSoni78/pollinations/tree/solution2-image-dimension-validation) — `MIN_SIDE_LENGTH = 16` in `params.ts`, `.min(16)` in the GET schema, APIDOCS.md rows updated, tests for zero/negative rejection and the 16px floor.
