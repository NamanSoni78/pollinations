# issue 73 — The text-generation cache is identity-blind, runs **before auth/balance**, and is never billed: unauthenticated cross-user replay of paid-model outputs, cross-tenant response poisoning, and rate-limit-free reads

**Severity: high (paid-only model content served with no key, no account, no rate limit, no billing; attacker can pre-seed cache entries that later victims receive as "fresh model output"; violates the repo's own stated isolation principle for agent runs)**
**Status: LIVE in production, verified 2026-10-23 (keyless 200 `X-Cache: HIT` replay of a key-warmed generation; identical cache-key across keyed and keyless requests; control shows auth runs on MISS — see "Live verification")**

## Live verification (2026-10-23, attacker role only, own key + keyless requests)

Probe: `POST https://text.pollinations.ai/v1/chat/completions`, body `{"model":"openai","messages":[{"role":"user","content":"<unique marker> reply with the single word: ok"}]}`.

| Step | Auth | Result |
|---|---|---|
| 1. Warm | `Authorization: Bearer sk_…` | `200`, generation created (response id `pllns_7ff181…`) |
| 2. Warm retry | `Authorization: Bearer sk_…` | `200`, **`X-Cache: HIT`**, same response id |
| 3. **Byte-identical replay** | **none — no key, no account** | **`200`, `X-Cache: HIT`, same response id, same body — the cached generation served pre-auth** |
| 4. Control (never-seen body) | none | `402 FREE_LIMIT` ("Free limit reached: 1 reply every 30 seconds per IP") — auth/rate limiting **does** run on MISS |

Decisive detail: the `X-Cache-Key` header of the keyed (step 2) and keyless (step 3) requests is **identical** (`ea4d378e5f6d60e2890b69aa532d7221…`) — proving the API key/identity is not part of the cache key and that one R2 entry serves both. Step 4 also proves the HIT path skipped the free-tier IP rate limit, not just billing: the same IP that got a 402 for a fresh body received unlimited 200 HITs for the cached one. Reproduction script: `scripts/poc-issue73-preauth-cache.mjs` in the report bundle.

## Summary

Every text-generation route (`/v1/chat/completions`, `/v1/responses`, `/alpha/decisions`, plus the audio routes) mounts a cache middleware **whose lookup happens before authentication, balance, and permission checks, and whose key contains no identity whatsoever**. The middleware's own doc comment states the design plainly:

```ts
// gen.pollinations.ai/src/middleware/text-cache.ts:1-13
/**
 * Text cache middleware
 * - Checks cache before auth/balance checks so cache hits can remain public
 * - Returns immediately on cache HIT
 * - On MISS: continues to auth/rate limiting/origin
 * ...
```

On `/v1/chat/completions` the order is explicit — cache sits **between tracking and the auth/balance gate**:

```ts
// gen.pollinations.ai/src/routes/proxy.ts:225-237 (chat completions; same shape for
// /alpha/decisions at :244-257 and /v1/responses at :263-274, and audio at
// gen.pollinations.ai/src/routes/audio.ts:4707,4830)
const chatCompletionHandlers = factory.createHandlers(
    every(largeChatBody, textBodyLimit),
    validator("json", CreateChatCompletionRequestSchema),
    mediaResponses("chat/completions"),
    resolveModel("generate.text", { supportedEndpoint: "/v1/chat/completions" }),
    every(textBalanceNotice, track("generate.text")),
    textCache,                                            // ← lookup HERE
    every(generationAccess, deduplicateGeneration),       // ← auth/balance only HERE
    apiKeyBudgetReservation,                              // ← key budget only HERE
    generateChatCompletion,
);
```

On a HIT, `lookup()` returns the stored R2 object immediately (`generation-cache.ts:233-234`) — the request never reaches `generationAccess` (auth, balance, paid-only gating, model permissions) or `apiKeyBudgetReservation`. And the tracker marks every hit unbilled:

```ts
// gen.pollinations.ai/src/middleware/track.ts:715-730
const cacheHit = response.headers.get("x-cache") === "HIT";
...
// Cache hits made no upstream attempt and must not claim one.
if (cacheHit) {
    return notBilled();
}
```

## The cache key has no identity in it — by construction

```ts
// gen.pollinations.ai/src/utils/text-cache.ts:120-198
export async function generateCacheKey(request, bodyText?, partition?, requiredSafetyFeatures = []) {
    ...
    .filter(([key]) => !EXCLUDED_PARAMS.includes(key.toLowerCase()))   // EXCLUDED_PARAMS = ["key", "no-cache"]
    ...
    const parts = [normalizedMethod, url.pathname, filteredParams.toString()];
    if (bodyText && (method === "POST" || method === "PUT")) {
        const filteredBody = {};                                        // strips only "key"/"no-cache" fields
        ...
        parts.push(stableStringify(filteredBody));
    }
    ...safety parts, stream version...
    if (partition) parts.push(`partition:${partition}`);
    return sha256(parts.join("|"));
}
```

There is **no Authorization header, no API key id, no user id, no referrer, no IP, no account tier** in the key. The only identity-ish element — `?key=…` and the body's `key` field — is **explicitly stripped so that requests from different keys share the same entry**. The one partition that exists is reserved for agent community models:

```ts
// gen.pollinations.ai/src/middleware/text-cache.ts:44-52
const cacheScope = variables.model?.cacheScope;                 // set ONLY for agent models
const partition = cacheScope
    ? `${cacheScope}:key:${variables.auth?.apiKey?.id ?? "anonymous"}:run:${c.var.requestId}`
    : undefined;                                                 // ← every other model: SHARED
```

…and the reason it exists is written next to it, in `middleware/model.ts:148-153`:

```ts
// An agent run executes tools and spends the caller's balance, so its
// answer belongs to that caller and must never be replayed to another.
```

That principle is exactly what the shared cache violates for **every non-agent model, including paid-only ones**: a paid generation spends the caller's balance, and its answer is then replayed to anyone. `shouldCache` is only `status === 200 && body !== null` (`text-cache.ts:33-35`) — no paid-only exclusion, no tier exclusion. Cached entries are served with immutable cache-control, and **every read refreshes the R2 TTL** (`refreshR2ObjectTtl` in `getCachedResponse`, `text-cache.ts:240-296`), so popular entries effectively never expire.

## Attack A — unauthenticated, unbilled, rate-limit-free replay of paid-model output (attacker-only)

1. A paying user runs `POST /v1/chat/completions` with body `B` on a **paid-only model**. They are billed; the response is stored in R2 under `sha256(POST|/v1/chat/completions|filter(B))`.
2. The attacker — **no key, no account, no headers** — sends the byte-equivalent request (any `?key=` or `key` differences are stripped from the key computation anyway).
3. `textCache` runs before `generationAccess` → R2 HIT → the paid response is returned. No auth ran, so no 401/402/403 can happen; no rate limiter ran; the hit is `notBilled`.
4. The attacker can hammer this endpoint for the same body unlimited (pairing with issue 65's missing rate limits), and the `X-Cache-Key` header even confirms hits to make sweeping easy.
5. Harvesting at scale: sweep **predictable/common request bodies** (template prompts, tutorial examples, popular system-prompt defaults, prompts induced through shared content) against paid-only models. Every HIT is free paid output generated (and paid for) by someone else.

## Attack B — cross-tenant response poisoning (attacker seeds, victims receive)

1. The attacker sends request body `B` themselves (free-tier key is enough on models the anonymous tier can reach; any signup key otherwise). The MISS is generated for them and cached under the shared key.
2. Every **other** user who later submits the identical body `B` — same prompt, same params — receives **the attacker's cached content presented as fresh model output** (`X-Cache: HIT` is just a header most clients ignore).
3. TTL-refresh on read keeps the poisoned entry alive as long as it keeps being requested. For apps that build decisions on pollinations output (agents, pipelines, "AI-verified" content), this is a data-integrity backdoor: the attacker controls what the model "said" to anyone who asks that exact question.
4. Victims are never billed for the poisoned hit either — so there is no billing anomaly to notice.

## Attack C — victim-response exfiltration

If an attacker can learn or predict a victim's exact request (shared templates, copy-pasted prompt examples, prompts induced via prompt injection in shared content), the cached response for that body is served to the attacker **without any credentials** — reading what the victim asked and what the model answered, pre-auth.

## Why "it's a public cache" doesn't cover this

- Free-tier anonymous caching of the classic `/text/:prompt` endpoint is a documented product behavior ("same prompt, cached result"). What is **not** defensible: **paid-only model responses — which require an account, a key with the right permissions, and a non-empty balance to create — are served back to unauthenticated callers with no rate limit and no billing**, while the codebase itself partitions agent responses precisely because "its answer belongs to that caller and must never be replayed to another."
- The `key`/`no-cache` stripping makes cross-KEY sharing explicit: two different paying users' identical requests share one entry — the second one gets the first one's output and pays nothing (`notBilled`), i.e. **the same prompt is billed exactly once globally, then free for everyone including keyless strangers**.
- `?no-cache=1` is stripped from the key and **never honored anywhere** in the lookup path (`getCachedResponse` is a bare `TEXT_BUCKET.get(key)`) — there is no supported way to force a fresh, non-poisoned generation.

## Recommended fix

1. Compute the cache key per **caller identity class**: at minimum `apiKey.id ?? "anonymous"` (as the agent partition already does) so authenticated, billed, and paid-only requests never share entries with anonymous replays.
2. Exclude paid-only / permission-gated models from the shared cache entirely (or partition them per key), mirroring the agent-model treatment.
3. Run the cache lookup **after** auth for routes that can return permission-gated content, so a HIT still proves the caller could have made the request (auth, not billing).
4. Honor `no-cache` as a documented refresh control (currently stripped and ignored).
5. Do not TTL-refresh entries on read indefinitely — bound entry lifetime so poisoned content ages out.

## Evidence table

| Fact | Location |
|---|---|
| "Checks cache before auth/balance … returns immediately on cache HIT" | `middleware/text-cache.ts:1-13` |
| Cache mounted before `generationAccess` + `apiKeyBudgetReservation` | `routes/proxy.ts:225-237, 244-257, 263-274`; `routes/audio.ts:4707, 4830` |
| Cache key = method+path+params+body, `EXCLUDED_PARAMS=["key","no-cache"]`, no identity | `utils/text-cache.ts:20, 120-198` |
| Per-key partition exists ONLY for agent community models + stated principle | `middleware/model.ts:148-153`, `middleware/text-cache.ts:44-52` |
| `shouldCache` = any 200 response (no paid-only exclusion) | `middleware/text-cache.ts:33-35` |
| Cache hits unbilled | `middleware/track.ts:715-730` |
| HIT returns before any auth runs | `middleware/generation-cache.ts:233-234` |
| TTL refreshed on every read (immortal popular entries) | `utils/text-cache.ts:240-296` (`refreshR2ObjectTtl`) |
| `no-cache` never honored (bare bucket get) | `utils/text-cache.ts:240-247` |
