# POST image endpoints silently rewrite out-of-range seeds to seed 42 (and bill for it)

## Summary

`POST /v1/images/generations` and `POST /v1/images/edits` accept any value for `seed` (the field is not in the validated schema — it rides the `.passthrough()`), and the generation pipeline then **silently replaces** out-of-range seeds with the sentinel seed `42`. The caller gets a **200 with a billed, deterministic image keyed to seed 42** — no error, no indication. The native GET image route rejects the same values with a clean 400.

## Live evidence (reproduced against production)

Sent `-5` in the POST body; the generated image's embedded metadata reports `"seed": 42`:

```
$ curl -s -X POST https://gen.pollinations.ai/v1/images/generations \
    -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
    -d '{"prompt":"b2-exif-proof red circle","seed":-5,"size":"64x64"}'
→ HTTP 200, usage: { output_tokens: 1 }   # billed

# decoded from the returned image's EXIF UserComment:
{"prompt":"b2-exif-proof red circle","seed":42,...}   # sent -5, got 42

$ curl -s "https://gen.pollinations.ai/image/tiny-red-square-icon?seed=-5" -H "Authorization: Bearer sk_..."
→ HTTP 400 Query parameter validation failed   # GET rejects the same value

$ curl -s "https://gen.pollinations.ai/image/tiny-red-square-icon?seed=3000000000" ...
→ HTTP 400 Query parameter validation failed
```

A seed of `3000000000` via POST behaves the same way: 200 + image keyed to seed 42, colliding with every other legit `seed=42` request in the shared cache.

## Root cause

- `shared/schemas/openai.ts` — `CreateImageRequestSchema` / `CreateImageEditRequestSchema` have no `seed` field; the comment on `.passthrough()` even says *"Allow Pollinations extensions: seed, safe, etc."*, but unlike `safe`, `seed` is never validated.
- `gen.pollinations.ai/src/image/params.ts` — `sanitizedSeed` ends with `.catch(SENTINEL_SEED)` (42), which swallows out-of-range values **after** they pass the unvalidated POST body.

## Impact

- Silent data corruption: the caller's explicit seed is discarded and the output is keyed to seed 42 without any signal.
- Cache pollution: an invalid-seed request shares the cache entry of every legitimate `seed=42` request.
- Contract inconsistency: GET returns a clean validation 400 while POST silently munges the value.

## Proposed fix

Add a validated `seed` field (`integer, -1…2147483647, nullable`) to both POST image schemas, mirroring the GET route and the chat route.

**Fix implemented in fork branch:** [`solution1-image-seed-validation`](https://github.com/NamanSoni78/pollinations/tree/solution1-image-seed-validation) — adds the field to both schemas, widens `resolveParams`'s seed type for `null`, updates APIDOCS.md, and adds route-level tests (`seed: -5 / 3000000000 / 12.5 / "not-a-number"` → 400 before the cache).
