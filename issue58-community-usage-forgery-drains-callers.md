# Community-model usage forgery: a public listing bills any caller its self-reported token count — and the owner pockets 75% as reward

## Summary

Every price a community model charges is computed from usage numbers **the community endpoint itself reports in its response**, with no magnitude bound anywhere:

```ts
// gen.pollinations.ai/src/text/handler.ts:185-211 — usageHeaders()
const usage = completion?.usage;              // ← upstream (community) response
const normalizedUsage = usage ? openaiUsageToUsage(...) : undefined;
... buildUsageHeaders(modelUsed, normalizedUsage)   // → x-usage-* response headers
```

```ts
// shared/schemas/openai.ts:628-670 — CompletionUsageSchema
completion_tokens: z.number().int().nonnegative(),   // ← NO upper bound
prompt_tokens:     z.number().int().nonnegative(),   // ← NO upper bound
```

`gen.pollinations.ai/src/text/chat/usage.ts:7-15` validates only the shape. The middleware then charges the caller exactly this:

```ts
// gen.pollinations.ai/src/middleware/track.ts:1339-1377 — extractUsageHeaders()
const usage = parseUsageHeaders(response.headers);   // the endpoint's own numbers
// track.ts:418-438
const deduction = await handleBalanceDeduction({
    totalPrice: responseTracking.price?.totalPrice,   // tokens × listing price
    ...
});
```

And the listing owner is simultaneously credited 75% of that charge:

```ts
// shared/billing/track-helpers.ts:49-76 — selectCommunityModelReward()
if (servedCommunityEndpoint?.visibility === "public") {
    return { userId: servedCommunityEndpoint.ownerUserId,
             rewardRate: COMMUNITY_MODEL_REWARD_RATE,   // 0.75
             basePrice: servedPrice };
}
// shared/community-endpoints.ts:28
export const COMMUNITY_MODEL_REWARD_RATE = 0.75;
```

The preflight `requireFunds`/reservation uses gen's *estimated* average price, so it does not stop the inflated post-hoc deduction.

## Impact (live-verified chain)

Live evidence (2026-10-22, real key): calling `community/CloudCompile/MiniMax-m3.1-flash:free` returned `x-usage-prompt-text-tokens: 208` / `x-usage-completion-text-tokens: 5` — literally the upstream's self-reported numbers — and calling the priced `community/tomdacatto/tower-kitchen-table` billed the caller's balance from those same headers.

Attack: an allowlisted community publisher (the `shared/auth/github-id-list.ts` allowlist — dozens of outside community members, not core staff) serves `"usage": {"prompt_tokens":0, "completion_tokens":1000000000, "total_tokens":1000000000}` in their endpoint's response for a model priced at the cap (`MAX_COMMUNITY_PRICE_PER_MILLION_TOKENS = 50`):

- any user who calls that public model is charged **1e9 × 50/1M = 50,000 pollen** — bounded only by their balance, drained in one request;
- the publisher is credited **0.75 × charge = 37,500 pollen** as a community reward — the attack is directly profitable;
- the same unbounded trust exists in the other modalities: transcription duration (`gen.pollinations.ai/src/audio/communityEndpoint.ts:206-210` + `communityTranscriptionSeconds`), video (`shared/community-media.ts:19-34`, `usage.duration`), and image token counts (`gen.pollinations.ai/src/image/communityEndpoint.ts:198-215`).

This is an arbitrary-caller wallet drain + self-enrichment primitive. The `communityModelRewardInput?.userId === userId` self-call exclusion does not stop it — the victim is a different account.

## Fix (minimal)

Sanity-bound self-reported usage at settlement, e.g. any of:

1. Cap the billable total at `K ×` the preflight estimate for the request (K ≈ 10 covers legitimate variance), and cap rewards to the same bounded base;
2. Validate reported tokens against measurable inputs (tokens ≤ f(request input size + max_tokens), duration ≤ uploaded media duration measured locally as stem-separation already does);
3. At minimum, reject settlement when reported usage deviates from the registration probe baseline by more than a fixed multiplier, and suspend reward crediting for the deviation window.
