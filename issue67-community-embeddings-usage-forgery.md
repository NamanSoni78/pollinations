# issue 67 — Community **embeddings** usage forgery: `/v1/embeddings` bills callers from the community endpoint's unbounded self-reported `prompt_tokens`

**Severity: high (same class as issue 58 — arbitrary caller wallet drain + 75% self-enrichment, on a route issue 58 did not list)**
**Status: LIVE in production, verified 2026-10-22 (caller-side, exact charge reproduced)**

## Summary

Issue 58 documented that community **model** usage is self-reported and unbounded on the text route. The same trust hole exists on the **embeddings** route, with its own parser, its own validation gap, and a live public community embedding model in the catalog. Nothing on the embeddings path caps what a community endpoint reports:

- `gen.pollinations.ai/src/embeddings/communityEndpoint.ts:82-88` — the community endpoint's response body is read; `usage = getOpenAIEmbeddingUsage(body)` and the response is re-validated with `usage: usage ?? { prompt_tokens: 0, total_tokens: 0 }` **before** the positivity check, so any numeric shape passes through.
- `gen.pollinations.ai/src/embeddings/communityEndpoint.ts:117-126` — the only billing constraint is **positivity**: `typeof usage.prompt_tokens === "number" && usage.prompt_tokens > 0`. There is **no upper bound**.
- `shared/registry/usage-headers.ts:101-120` — `getOpenAIEmbeddingUsage` accepts `prompt_tokens` via `isTokenCount` only.
- `shared/registry/usage-headers.ts:351-355` — `isTokenCount` = `Number.isSafeInteger(value) && value >= 0`: any safe integer up to **2^53** is accepted.
- `gen.pollinations.ai/src/embeddings/communityEndpoint.ts:127-133` + `:161-181` — `billableUsage = { promptTextTokens: usage.prompt_tokens }` is serialized into `x-usage-prompt-text-tokens` on the response via `buildUsageHeaders`.
- `gen.pollinations.ai/src/middleware/track.ts:1367-1376` — the settlement reads those headers back with `parseUsageHeaders` (`shared/registry/usage-headers.ts:455-474`, plain `Number(value)`) and bills the caller exactly that amount; `shared/billing/track-helpers.ts:445-476` (`creditCommunityOwner`) pays the community owner 75% of the charge into the payer's bucket.

The embeddings route is not an afterthought: `community/pegalink/embedding-gemma-300m` is a **public community embedding model live in the catalog today** (priced at 0.00000035 pollen per prompt token).

Live verification (attacker's role = caller; the forgery itself is the endpoint owner's):

```
$ curl -s -D- -X POST https://gen.pollinations.ai/v1/embeddings \
    -H "Authorization: Bearer sk_…" -H "Content-Type: application/json" \
    -d '{"model":"community/pegalink/embedding-gemma-300m","input":["hello world this is a live billing verification"]}' |
    rg -i "x-usage|x-model|x-cache"
x-model-requested: community/pegalink/embedding-gemma-300m
x-model-used: community/pegalink/embedding-gemma-300m
x-usage-prompt-text-tokens: 14          <- chosen entirely by the endpoint's server

$ GET /account/key before:  pollenBudget: 1.7922701
$ GET /account/key after:   pollenBudget: 1.7922652
  1.7922701 − 14 × 0.00000035 = 1.7922652   (exact — the self-report is the charge)
```

The `14` came from pegasus/pegalink's server, not from gen counting anything. A caller cannot verify or refuse it.

## Attack

Attacker = owner of any **public** community embedding model (publishing is allowlist-gated, `enter.pollinations.ai/src/routes/community-endpoints.ts:123-138`, same as issue 58 — an approved community member, or a compromised approved account):

1. Victim calls `POST /v1/embeddings` with `model=community/<attacker>/…` (they are in the public `/models` catalog with pricing, exactly like `community/pegalink/embedding-gemma-300m`).
2. Attacker's endpoint answers with `"usage": {"prompt_tokens": 1000000000, "total_tokens": 1000000000}` (valid response shape, positive, safe integer).
3. Victim is charged `1e9 × 0.00000035 = 350 pollen` from their wallet by `handleBalanceDeduction` — preflight (`requireFunds`) used gen's estimate for a few-token input and cannot stop the post-hoc inflated settlement (same mechanics as issue 58).
4. Attacker is credited `0.75 × 350 = 262.5` pollen via `creditCommunityOwner`.
5. At the maximum accepted safe integer the charge is unbounded in practice; repeatable per request.

## Fix (minimal)

Mirror whatever cap is adopted for issue 58 onto the embeddings path — the check belongs where the endpoint's numbers enter billing:

- In `gen.pollinations.ai/src/embeddings/communityEndpoint.ts` (the `!usage || … prompt_tokens <= 0` block at `:117-126`), additionally reject `usage.prompt_tokens > MAX_COMMUNITY_SELF_REPORTED_TOKENS` (a sane per-request bound, e.g. 1e7).
- And/or bound `isTokenCount` in `shared/registry/usage-headers.ts:351-355` (cap the accepted magnitude instead of accepting every safe integer).
- Pair with the `Number.isFinite` fix from issue 68 (the embeddings body parser and `parseUsageHeaders` both accept non-finite numbers today).

Cross-references: issue 58 (text/audio/video/image community paths), issue 68 (NaN/Infinity through the same headers).
