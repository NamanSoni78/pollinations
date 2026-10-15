# Non-streaming completions with no output are cached and replayed — the #16911 fix only guarded streams

## Summary

#16911 stopped the text cache from storing SSE streams whose choices carry no output (a reasoning model that spent `max_tokens` on reasoning, leaving `content` empty). The **non-streaming** twin is still open: `shouldCache` only checks `status === 200`, and the emptiness guard (`isUncacheableStream`) only inspects `text/event-stream` bodies. A JSON completion with `content: null` is cached and **replayed byte-for-byte to every identical request** — including agents' inner calls, which then keep failing "without ever reaching a model", the exact failure mode #16911 described.

## Evidence (live, against gen.pollinations.ai)

```
POST /v1/chat/completions
  model: z-ai/glm-5.3-flash  (mandatory-reasoning model; reasoning hidden in reasoning_content)
  messages: [{role:"user", content:"Solve 17*23 step by step, then give the final number."}]
  max_tokens: 1

call A: 200 {"id":"chatcmpl-5aaf729c",...,"choices":[{"message":{"role":"assistant","content":null},"finish_reason":"length"}]}
call B (identical, 2s later): 200 — byte-identical body, same id "chatcmpl-5aaf729c"
```

Call B never reached the model: it was served the cached empty completion. (The `x-cache: HIT` signal is masked by the separate always-HIT defect on this route; identity of `id` proves the replay.) The GET `/text` variant is affected too — an empty completion renders as the JSON message fallback `{"role":"assistant","content":null}` (content-type `application/json`), which is cached the same way.

## Root cause

`gen.pollinations.ai/src/middleware/text-cache.ts` — `createCaptureStream`'s flush only consults `isUncacheableStream`, which returns `false` for anything that is not SSE:

```ts
if (isUncacheableStream(response, completeResponse)) { resolveWrite(); return; }
await c.env.TEXT_BUCKET.put(cacheKey, completeResponse, { ... });   // empty 200 JSON cached
```

The #16911 author deliberately did not extend the skip to non-streaming results: **the generation coordinator delivers non-streaming responses by reading the cache entry back**, so skipping the write turns an empty answer into a 503 (documented in that commit's history). The fix therefore cannot simply skip the write.

## Fix

Branch `solution17-nonstream-empty-cache-guard` (commit `19483de3`):

- Empty **non-streaming** bodies are still written (delivery intact) but now carry an `empty_output` R2 metadata marker (`isEmptyChatCompletionBody` recognizes the Chat Completions shape and the GET `/text` bare-message fallback; embeddings/responses/decisions JSON never match).
- The **public** read (`getCachedResponse`) and the coordinator's freshness check (`GenerationCoordinator.cacheExists`, via `head().customMetadata`) treat marked entries as misses, so the next identical request executes again.
- The coordinator's post-settlement read-back uses a new `getForDelivery` adapter method (raw read) so waiters still get the body their run produced.
- `COMPLETION_CACHE_VERSION = "completion-output-v1"` retires pre-marker entries, mirroring how #16587's stream fix retired stream keys.

Three new tests in `test/text-cache.test.ts` (empty completion written-but-not-replayed + marker present; content/tools/refusal/embedding/response shapes still cached; bare-message fallback written-but-not-replayed). Full suite: 2831+ passed, `tsc` clean.
