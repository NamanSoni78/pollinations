# Non-streaming completions leak InferencePort's payg_* ledger — including our account balance — to clients

## Summary

#16265 hid the provider's PAYG ledger from **streams** (`withoutPayg` in `text/chat/public.ts`, top level + usage) and from **non-streaming usage** (`publicCompletionUsage` in `text/handler.ts`). But the **top level of a non-streaming completion was never filtered**: an InferencePort response carrying `payg_usage` at the root — the exact shape the stream fix strips — passes through `publicChatCompletion` unchanged and reaches the client in full. The ledger includes `payg_ledger_entry.balance_after`: **the gateway's own InferencePort account balance**.

## Evidence (reproduced through the real worker, mocked provider)

`test/text/publicChat.test.ts`-style harness: `POST /v1/chat/completions`, model `inferenceport-ai/lightning-text-v2.1`, mocked `api.inferenceport.ai` returning —

```json
{
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "🌼 hello" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4, "payg_credits_charged": 0.0001 },
  "payg_usage": { "payg_credits_charged": 0.0001, "payg_ledger_entry": { "balance_after": 38.9 } }
}
```

Client response body (200, unmodified):

```json
{"id":"chatcmpl-nonstream",...,"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4},"payg_usage":{"payg_credits_charged":0.0001,"payg_ledger_entry":{"balance_after":38.9}}}
```

`usage.payg_credits_charged` is stripped correctly; the top-level `payg_usage` — with the balance — is not. The top-level shape is not hypothetical: #16265's own stream test uses precisely `{"id":"chatcmpl-proxy-meta","choices":[],"payg_usage":{...}}` as the wire format, and the provider attaches the same ledger entry to non-streaming bodies.

## Root cause

`gen.pollinations.ai/src/text/handler.ts` `publicChatCompletion`:

```ts
const usage = publicCompletionUsage(completion.usage);      // usage-only filter
if (!isVercel && usage === completion.usage) return completion;  // ← returned as-is, payg_usage intact
const publicCompletion = {
    ...completion,                                           // ← spread keeps top-level payg_*
    usage,
    ...
};
```

`text/chat/public.ts` has `withoutPayg` — but only `publicChatStream` calls it. Both lightning-text models (`inferenceport-ai/lightning-text-v2`, `-v2.1`) are `paidOnly`, so this is not live-probeable with a tier key; the gateway-side gap is proven above through the real handler.

## Impact

- Every **non-streaming** request to the two InferencePort Lightning Text models returns the provider ledger — charged credits and the service account's remaining balance — to whoever calls the model. This is internal financial metadata, the same class #16265 explicitly set out to hide ("payg_* fields hold its ledger entry, including our account balance").
- GET `/text` is unaffected (it renders only the message), so the leak is specific to the JSON completion routes.

## Fix

Branch `solution16-payg-nonstream-ledger-strip` (commit `7c4e383d`): exports `withoutPayg` from `text/chat/public.ts` and applies it to the completion object in `publicChatCompletion`, with the early-return conditioned on a top-level `payg_*` scan — usage-only filtering stays as-is. New regression test (`publicChat.test.ts`): the body above reaches the client with no `payg` substring and no `balance_after`. Full suite: 2847 passed, `tsc` clean.
