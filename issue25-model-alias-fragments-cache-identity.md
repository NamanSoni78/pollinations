# Model aliases fragment the generation-cache identity: one generation, one entry per spelling, rebilled every time

## Summary

The generation-cache identity uses the **requested** model string, not the **resolved** canonical id. Every alias of a model therefore gets its own cache entry for what is the same generation:

- `openai` and `openai/gpt-5.4-nano` (`aliases: ["gpt-5.4-nano", "openai"]`)
- `jev` and `typesafe/jev-1.13` (`aliases: ["jev", "typesafe/jev"]`)
- `flash` and `elevenlabs/eleven-flash-v2.5` (`aliases: ["tts-flash", "eleven-flash", "flash", "elevenflash"]`)
- `nanobanana` and `google/gemini-2.5-flash-image`, `kontext` and `black-forest-labs/flux.1-kontext-pro`, `sana` and `lykon/dreamshaper-8-lcm`, …

Aliases are pure name mappings (`model-registry.ts` builds one `byIdOrAlias` map; an alias resolves to the *same* entry, definition, and upstream), so two requests that differ only in the model spelling produce byte-identical upstream calls. But the cache key hashes the raw spelling — the body `model` field on POST routes, the `?model=` query param on GET routes (`utils/text-cache.ts` filtered params; `utils/media-cache.ts` searchParams).

Consequences:

1. **Duplicate generation + double billing.** A client that spells the model one way (docs, examples, `DEFAULT_TEXT_MODEL` echoed back from `/v1/models`) and a client that spells it the other way (the alias table, marketing names like "flash" or "nanobanana") each pay full generation price for an answer that was already cached.
2. **No single-flight across spellings.** Concurrent identical requests through different spellings do not join one coordinator job — each runs its own upstream generation.
3. **Stale replay after alias retargeting.** Cache entries are immutable and TTL-refreshed on hit. When an alias is repointed (e.g. `openai` → the next nano model), the old alias-keyed entry stays hot and keeps serving the *old* model's output under the *new* alias indefinitely — there is no version tied to what the alias actually resolved to.

The platform already applies the correct normalization in one place: `media/responses.ts:119` rewrites `model` to `entry.id` when it rebuilds the media URL for the chat/responses adaptation path (`url.searchParams.set("model", entry.id)`). The rest of the routes never got the same treatment.

## Evidence

Live against `gen.pollinations.ai` with a paid key (balance printed between probes):

```
A1 chat {model: "openai/gpt-5.4-nano", messages, max_tokens}  -> 200, fresh id, billed
A2 chat {model: "openai/gpt-5.4-nano", ...}                    -> 200, identical id (cached replay), not billed
A3 chat {model: "openai", ...}                                 -> 200, DIFFERENT id, balance dropped again
A4 chat {model: "openai", ...}                                -> 200, identical to A3 (alias entry replays)
```

The same split reproduces on `/v1/responses` and `/alpha/decisions` (probe script `scripts/bug-verify-wave7-text-identity.mjs`).

Worker-level repro (`test/model-alias-cache-identity.test.ts` in the solution branch, real DOs + mocked upstreams + test D1) — four routes, four `expected 2 to be 1` upstream executions on stock `main`:

```
× shares the chat cache entry across model aliases        (POST /v1/chat/completions, "openai" vs canonical)
× shares the simple text cache entry across model aliases (GET /text/:prompt, ?model=openai vs canonical)
× shares the decisions cache entry across model aliases   (POST /alpha/decisions, "jev" vs canonical)
× shares the audio cache entry across model aliases       (GET /audio/:text, ?model=flash vs canonical)
```

All four green after the fix: the alias request answers `x-cache: HIT`, the upstream runs exactly once, and the payer is billed once.

## Root cause

- `gen.pollinations.ai/src/utils/text-cache.ts` — `generateCacheKey` folds the raw `?model=` query value into the filtered params and the raw body `model` field into `filteredBody`; nothing passes the resolved id in.
- `gen.pollinations.ai/src/middleware/text-cache.ts` — the text adapter has `c.var.model` in scope when it computes the key (resolveModel runs earlier on every text route) but only uses it for safety features and agent scoping.
- `gen.pollinations.ai/src/middleware/media-cache.ts` — the media adapter hashes the raw query `model` and the raw `generationCacheBody` (which carries the body's model spelling on the audio POST routes; the image POST routes already rebuild theirs from a whitelist).

## Fix

Branch `solution25-model-alias-cache-identity` (@ `81ce28eb`):

- `generateCacheKey` takes the resolved canonical model and rewrites the spelling to it — both the `model` query param value and the JSON body `model` field. Rewriting in place (rather than dropping/injecting) keeps the key format stable: existing canonical entries keep hitting, only alias-spelled entries orphan (they were the duplicates). A POST body never reads the query for its model (resolution reads the body only), so an alias query spelling there is dead weight that the rewrite also removes.
- The text adapter passes `variables.model?.resolved` into `generateCacheKey`.
- The media adapter rewrites the `?model=` value to the resolved id when the param is present, and rewrites the `model` field inside `generationCacheBody` before hashing, covering the audio POST routes.

Two `community-endpoints.test.ts` cases pinned the old behavior (asserting two upstream calls for one canonical + one legacy-alias request); their per-spelling prompts now vary so each spelling independently routes, preserving the tests' intent.

Regression tests cover chat, simple text, decisions, and audio across alias/canonical pairs, asserting single execution, `x-cache: HIT`, and a single balance deduction. Full suite green (2876 passed), `tsc` clean, biome clean.
