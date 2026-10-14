# One non-JSON SSE data event kills the whole client stream when `include_reasoning:false` is set

## Summary

`genericOpenAIClient.transformStreamCompletions` rewrites SSE chunks for streaming requests that activate it — `include_reasoning: false` (a documented OpenRouter/Vercel passthrough parameter) or any `useMistralChatFormat` model. It is the **only stream rewriter in the repo with an unguarded `JSON.parse`**: a single non-JSON `data:` event (provider keep-alive, metadata line, truncated frame from an intermediary) makes it throw inside the parser callback, which errors the `TransformStream` and **abruptly terminates the client-facing response mid-generation** — partial content, no `[DONE]`, no error frame. The two sibling parsers (`chat/usage.ts`, `chat/public.ts`) already tolerate non-JSON events; this one kills the stream.

## Evidence (reproduced against the module with a mocked provider)

```
upstream SSE:  data: {"choices":[{"delta":{"content":"Hel"}}]}
               data: ping
               data: {"choices":[{"delta":{"content":"lo"}}]}
               data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
               data: [DONE]

control (no include_reasoning): 445 chars delivered, [DONE] seen, stream completes
include_reasoning:false:        reader throws `Unexpected token 'p', "ping" is not valid JSON`
                                only the first chunk ("Hel") was delivered; no [DONE]
```

## Root cause

`gen.pollinations.ai/src/text/genericOpenAIClient.ts:136` (the rewriter activates when `hideReasoning || normalizeContent`):

```ts
onEvent(event) {
    let data = event.data;
    if (data.trim() !== "[DONE]") {
        const completion = JSON.parse(data) as ChatCompletion;   // ← unguarded
        transform(completion);
        data = JSON.stringify(completion);
    }
    ...
}
```

Compare the established in-repo convention, `chat/public.ts:47-60`:

```ts
try {
    const chunk = JSON.parse(data) as ChatCompletion;
    data = JSON.stringify({ ...chunk, choices: publicChatChoices(chunk.choices) });
} catch {
    // Leave non-JSON events unchanged; validation happens before the tee.
}
```

and the billing parser `chat/usage.ts:51-54` (`try { event = JSON.parse(...) } catch { return; }`), which exists precisely because the codebase already expects non-JSON data events from some providers.

## Impact

- Any client streaming with `include_reasoning: false` (OpenRouter-style consumers; the parameter is declared in `shared/registry/text-parameters.ts` for several models) loses the entire response tail after the first non-JSON event — silent truncation that looks like provider flakiness.
- Mistral-format models route every streaming request through the same rewriter, with no client opt-in.
- The failure also swallows the terminal usage chunk for billing validation, compounding with the usage-missing error path.

## Fix

Branch `solution11-stream-json-parse-guard` (commit `cbcd605`): the parse/transform/stringify block is wrapped in the same tolerance pattern as `publicChatStream` — non-JSON data events pass through byte-for-byte unchanged. New regression test in `test/text/genericOpenAIClient.test.ts` (stream with `data: ping` mid-flight: all chunks + `[DONE]` delivered). Full suite: 2797 passed.
