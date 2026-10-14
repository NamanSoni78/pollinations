# GET /text/{prompt} is missing the seed cap and reasoning_effort enum that /v1/chat/completions enforces

## Summary

The GET text route accepts **any integer seed** (no upper bound) and **any string** for `reasoning_effort`, forwarding both verbatim to providers. The chat POST route validates the same parameters and returns clean 400s. The result: GET requests with a typo'd or oversized parameter surface **raw provider errors that leak the upstream body**, while the identical mistake on POST gets a clean validation message.

## Live evidence (reproduced against production)

```
# GET with an invalid reasoning_effort — raw Azure/Portkey internals leaked:
$ curl "https://gen.pollinations.ai/text/hi?reasoning_effort=banana" -H "Authorization: Bearer sk_..."
→ HTTP 400
  {"message":"400 Bad Request: azure-openai error: Invalid value: 'banana'. Supported values are: 'low', 'medium', 'high', and 'xhigh'.",
   "details":{"name":"UpstreamError","upstreamHost":"portkey.myceli.ai",
               "upstreamBody":"{\"error\":{\"message\":\"azure-openai error: ..."}}}

# The same mistake on the chat route — clean validation error:
$ curl -X POST https://gen.pollinations.ai/v1/chat/completions ... -d '{...,"reasoning_effort":"banana"}'
→ HTTP 400
  {"fieldErrors":{"reasoning_effort":["Invalid option: expected one of \"none\"|\"minimal\"|\"low\"|\"medium\"|\"high\"|\"xhigh\"|\"max\""]}}

# GET with an oversized seed — silently forwarded to the provider:
$ curl "https://gen.pollinations.ai/text/hi?seed=99999999999" -H "Authorization: Bearer sk_..."
→ HTTP 200 "Hi! 👋 How can I help you today?"     # no validation; provider tolerated it this time

$ curl -X POST .../v1/chat/completions ... -d '{...,"seed":99999999999}'
→ HTTP 400 {"fieldErrors":{"seed":["Too big: expected number to be <=2147483647"]}}
```

## Root cause

`gen.pollinations.ai/src/schemas/text.ts`:
- `seed: z.coerce.number().int().min(-1).optional()` — no `.max()`. The INT32_MAX cap was shipped for the GET image route and the shared chat schema (`ce78b3a`, *"INT32_MAX for compatibility with strict providers like Vertex AI"* — Vertex/Azure are text providers here) but never landed in the GET text schema.
- `reasoning_effort: z.string().optional()` — free-form, vs the `enum(["none","minimal","low","medium","high","xhigh","max"])` the chat schema enforces.

## Impact

- Deterministic parity break between the two entry points for the same parameter.
- Strict providers reject oversized seeds and invalid efforts with errors that leak `upstreamHost` and `upstreamBody` internals — a worse experience *and* an information disclosure the chat route avoids.
- The default model happens to tolerate seed overflow today, so the missing cap is invisible until a strict provider rejects it.

## Proposed fix

Mirror the chat schema in `GenerateTextRequestQueryParamsSchema`: `.max(2147483647)` on seed, the same `z.enum(...)` on `reasoning_effort`.

**Fix implemented in fork branch:** [`solution4-text-get-param-validation`](https://github.com/NamanSoni78/pollinations/tree/solution4-text-get-param-validation) — two-field schema fix + parity tests (overflow/negative seeds and every enum value).
