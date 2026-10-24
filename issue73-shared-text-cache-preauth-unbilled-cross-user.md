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

Every text-generation route (`/v1/chat/completions`, `/v1/responses`, `/alpha/decisions`, plus the audio routes) mounts a cache middleware **whose lookup happens before authentication, balance, and permission checks, and whose key contains no identity whatsoever** — and the media routes share the same mounting order (`routes/proxy.ts:198-206`: `track → imageCache → generationAccess → …` for image/video, and `model3dCache` likewise at :208-217), so the pattern covers paid image/video/3D generations too. The middleware's own doc comment states the design plainly:

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

## Scope addendum — the complete pre-auth cache mount map (2026-10-23, wave-25 verification)

The original report named the chat-style text routes. Re-walking every route that mounts a generation cache confirms the pattern is total — every cacheable generation surface on gen.pollinations.ai serves HITs before auth/balance/permission checks, with the same identity-blind key. Full map:

| Route | Cache middleware | Mount order (cache before auth) | What a keyless HIT leaks |
|---|---|---|---|
| `POST /v1/chat/completions` | `textCache` | `routes/proxy.ts:227` | paid text output (Attack A) |
| `POST /v1/responses` | `textCache` | `routes/proxy.ts:241` | same, responses protocol |
| `POST /alpha/decisions` | `textCache` | `routes/proxy.ts:266` | agent-decision output |
| `POST /v1/embeddings` | `textCache` | `routes/proxy.ts:887` | **paid embedding vectors** — per-token-billed embedding output (openai/cohere/gemini embedding models are paid), replayed keyless and unbilled |
| `POST /text` and `GET /text/:prompt` | `textCache` | `routes/proxy.ts:916, 958` | classic endpoint (shared cache here is documented product behavior; paid-model calls through it are still billed once globally) |
| `POST /v1/audio/speech` (+ `/speech/with-timestamps`) | `audioCache` (media/R2) | `routes/audio.ts:4583` | paid synthesized audio files |
| `POST /v1/audio/voice-changer` | `audioCache` | `routes/audio.ts:4369` | paid voice-changer output |
| `POST /v1/audio/voice-isolator` | `audioCache` | `routes/audio.ts:4425` | paid isolated-stem audio |
| `POST /alpha/audio/stem-separation` | `audioCache` | `routes/stem-separation.ts:83` | paid stem files (zip) |
| chat/responses calls that select an image/audio/3D model | `imageCache`/`audioCache`/`model3dCache` | `src/media/responses.ts:146` (`cache` before `generationAccess`) | the chat-protocol bridge for media models is ALSO pre-auth: `POST /v1/chat/completions` with an image/audio/3D model mounts the media cache before auth |
| native image/video routes | `imageCache` | `routes/proxy.ts:200` | (already in scope note: paid image/video files) |
| native 3D routes | `model3dCache` | `routes/proxy.ts:211, 1160` | paid 3D assets |

Two consequences specific to the newly-confirmed routes:

1. **Embeddings (`POST /v1/embeddings`) are the strongest poisoning target.** Embedding responses are pure vectors — deterministic, high-value, and consumed by RAG/retrieval systems that store them long-term. An attacker who seeds the cache for a body their victim's ingestion pipeline will later submit (shared corpus chunks, popular document excerpts, template text) silently corrupts the victim's vector store: retrieval quality degrades or attacker-influenced results surface, with `X-Cache: HIT` on the victim's response as the only (ignored) signal. The victim is also `notBilled` — no billing anomaly to detect.
2. **Media-file routes keep provider metadata headers on HIT.** `mediaCacheAdapter.get` serves the stored R2 object with `CACHED_HEADERS` (song-id, generation-id, x-model-used, x-usage-*), so a keyless replay of an audio HIT even leaks which upstream model produced it and its usage.

The fix section above applies unchanged to every row of this table: partition by caller identity (or drop the shared cache for paid models), and place the lookup after auth for anything that can return permission-gated content.

## Scope addendum 2 — transcription + simple-audio mounts were missing from the map; `with-timestamps` uses the wrong cache (2026-10-23, wave-26 verification)

Re-walking the two audio route families that return **JSON, not media files** found three rows the addendum table above did not carry, plus one correction. The pattern is unchanged — every mount below serves HITs from the shared identity-blind key before `generationAccess` — but the transcription family has victim classes the text routes do not.

### 1. `POST /v1/audio/transcriptions` — textCache, MISSING from the map

```ts
// gen.pollinations.ai/src/routes/audio.ts:4714-4835 (order as mounted)
.post("/transcriptions",
    resolveModel("generate.audio", { defaultModel: "openai/whisper-large-v3", … }),  // :4824
    track("generate.audio"),                                                        // :4828
    prepareGenerationRequest,                                                       // :4829
    textCache,                                   // ← lookup HERE (:4830)
    generationAccess,                             // ← auth/balance only HERE (:4831)
    deduplicateGeneration,
    apiKeyBudgetReservation,
    handleTranscription,
)
```

This route returns the **transcript of an audio file** as JSON. `openai/whisper-large-v3` is `paidOnly: false` at $0.163/hour (`shared/registry/audio.ts:662-679`), so any signup key — including a Quest-pollen-only balance — can seed entries. Consequences the text-cache rows do not have:

- **Confidential transcripts served to anyone holding the file bytes.** Speech-to-text output routinely contains private content (voice memos, meetings, medical/legal dictation). Once any user transcribes file `F` with params `P`, the transcript sits in the shared TEXT bucket retrievable **without any key or account** by anyone who later obtains the same audio bytes (a leaked recording archive, a shared drive, a breach). In a leak scenario where an attacker can read raw audio but has no Pollinations account, every previously-transcribed file's content is already extracted and keyless.
- **Multipart identity is boundary-independent — cross-client, not just cross-user.** `prepareGenerationRequest` normalizes the multipart body (`middleware/generation-cache.ts:81-110`): the cache identity is `stableStringify({ field: { file name, file type, sha256(bytes) }, … })` with only the `key` field stripped. The random multipart boundary each client generates is **not** part of the key, so a curl-seeded entry is served to a Python/browser victim and vice versa — no client fingerprint needs to match.
- **Ground-truth poisoning with a low seed cost.** Pipelines ingest transcripts as authoritative text (subtitles, meeting minutes, evidence workflows). An attacker seeds entries for audio that third parties commonly transcribe (public clips + default params) for fractions of a cent of Quest pollen; every later identical request receives the cached entry presented as fresh model output. The `prompt` form field does participate in the key, so a victim passing their own `prompt` is not served a `prompt`-differing seed — but default-parameter victims are.
- The victim side is `notBilled` and rate-limit-free exactly as in Attack A/C.

### 2. `POST /v1/audio/speech/with-timestamps` — textCache, not audioCache (correction)

The addendum table listed this route under `audioCache` at `audio.ts:4583`. It is a separate mount at `:4701-4711` using **`textCache`** (`:4707`) before `generationAccess` (`:4708`). It cannot use the media adapter (`audioCache.shouldCache` accepts only `audio/` / `application/zip`, `middleware/media-cache.ts:62-67`) because its response is JSON — base64 audio plus character alignments — so the entire payload lands in the shared TEXT bucket, pre-auth, like any chat response. Two additions:

- The response embeds synthesized audio as base64 inside JSON, so each cache entry costs ≈ 1.33× the audio size in R2 TEXT storage, and `createCaptureStream` has **no per-entry size cap** (`utils/text-cache.ts:296-369` — `totalSize` is only logged). With `input` up to 10,000 characters, a single entry reaches megabytes, and unique inputs seed unbounded unique entries — a storage-amplification surface on top of the replay issue.
- The alignment JSON is deterministic per (input, voice, format, seed) — the same identity-blind replay and pre-seed poisoning as chat bodies applies to it directly.

### 3. `GET /audio/:text` — audioCache, MISSING from the map

```ts
// gen.pollinations.ai/src/routes/proxy.ts:1165-1216
.get("/audio/:text",
    …
    track("generate.audio"),                                                        // :1210
    audioCache,                                   // ← lookup HERE (:1211)
    generationAccess,                             // ← auth/balance only HERE (:1212)
    …
)
```

The simple GET audio endpoint (speech/music, prompt in the path) serves cached paid audio files keylessly before auth — same row semantics as the POST audio file routes already in the table, listed here so the map is complete.

### Corrected complete map

| Route | Cache middleware | Mount (cache before auth) |
|---|---|---|
| `POST /v1/audio/transcriptions` | `textCache` (shared TEXT bucket) | `routes/audio.ts:4830` (auth `:4831`) — **new row** |
| `POST /v1/audio/speech/with-timestamps` | `textCache` (shared TEXT bucket) | `routes/audio.ts:4707` (auth `:4708`) — **corrected from `audioCache`** |
| `GET /audio/:text` | `audioCache` (media/R2) | `routes/proxy.ts:1211` (auth `:1212`) — **new row** |

All rows above join the fix unchanged: identity-partitioned keys (or no shared cache for paid/permission-gated models), lookup after auth, bounded entry size for the TEXT bucket.

## Addendum 3 — independent third-party corroboration (2026-10-24)

A second security agent (reporter's own AI agent, report shared by the bounty reporter on 2026-10-24) independently produced a 9-finding report against production `gen.pollinations.ai`, of which **8 of 9 findings (their VURN-1/2/3/5/6/7/8/9) are the same root cause as this issue 73** — the identity-blind shared cache mounted ahead of auth/balance checks. We cross-verified every claim against our own code audit and live tests. Summary of the cross-check:

| Their ID | Surface | Cross-check result |
|---|---|---|
| VURN-1 | `GET /text/:prompt` keyless HIT | **Confirmed, duplicate of issue 73 core.** Re-verified live 2026-10-24: keyed request → `x-cache: MISS`; immediate keyless replay of the same URL → `x-cache: HIT` with identical body (md5 `7d9812c2a3b7ab75daf40549fca84d91`, same `x-cache-date`), no pollen debited on the HIT. |
| VURN-2 | `/image`, `/v1/images/*` media cache | **Confirmed, duplicate** — already covered by our scope addendum (image/video/3D share the same pre-auth mounting). |
| VURN-3 | `POST /v1/chat/completions` | **Confirmed, duplicate** — core scope of this issue; the platform's own route docs disclose: "Identical requests may be answered from a shared cache, also for callers without an API key." |
| VURN-5 | `POST /v1/embeddings` | **Confirmed, duplicate** — covered by addendum 1 (embeddings mount map). |
| VURN-6 | `/v1/audio/*` | **Confirmed, duplicate** — covered by addenda 1-2 (audio file routes, transcriptions, `with-timestamps`, `GET /audio/:text`). |
| VURN-7 | "safety-feature cache key collision" | **Claim itself is incorrect** (see below), but the underlying shared-cache behavior is this issue. |
| VURN-8 | image "cache poisoning" | **Confirmed, duplicate** — the cross-tenant poisoning impact already documented here. |
| VURN-9 | rate-limit evasion via cache | **Confirmed, duplicate** — the "no rate limit on HITs" impact already documented here. |

Two of their specific sub-claims did **not** verify and should not be folded into a fix for this issue:

1. **`/v1/models` is NOT part of this cache family** (their VURN-4, "cached model listing leaks restricted models"). Live check 2026-10-24: `GET /v1/models` responses carry no `X-Cache`/`Age` header and no text-cache middleware is mounted on the models routes — the source explicitly states `src/middleware/text-cache.ts:29` "Non-cacheable routes like /v1/models should NOT use this middleware", and grep of `src/routes/proxy.ts` confirms no `textCache` in the models handler chain. The anonymous model list is the intended public catalog (409 entries incl. `paid_only` metadata, which is pricing-page-style disclosure, not an access grant — anonymous calls to paid models still fail auth/balance). Critically, the owner-only private community model visible on an authenticated listing (`community/07mrbeastofficial/asdf` on our test key's account) is **absent from the anonymous list** — no cross-user model-catalog leak exists on this route.
2. **Safety features ARE part of the cache key** (their VURN-7 "collision across safety features"). `generateCacheKey()` in `src/utils/text-cache.ts` includes the `x-safe` header, the `safe` query/body param, a `required-safety:<features>` part and a `SAFETY_CACHE_VERSION` salt; their PoC for this sub-claim compared two byte-identical requests (`?safety=on` twice), which demonstrates nothing.

Note on their report's code evidence: the quoted snippets do not match the actual codebase (their `generateCacheKey(request, safeHeader, requiredSafetyFeatures)` signature and `createTextCache()` / `src/routes/openai.ts` artifacts do not exist — the real signature is `generateCacheKey(request, bodyText?, partition?, requiredSafetyFeatures?)` and the middleware is `createGenerationCache(textCacheAdapter)`). The behavioral conclusion still reproduces exactly as this issue documents. Full disposition table: `verification-other-agent-report-vurn1-9.md`.
