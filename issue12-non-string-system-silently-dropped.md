# Non-string `system` on chat routes is silently discarded — the instruction just vanishes

## Summary

`POST /v1/chat/completions` and `POST /text` accept a top-level `system` field (the Pollinations extension that `GET /text` documents as a query param). The request schema is `.passthrough()` with `system` undeclared, and `getChatRequestData` only prepends the system message when `typeof system === "string"`. Send it as an **array** (the Anthropic-style `[{type:"text",text:...}]` shape), a number, or an object and the request returns **200 with the system prompt silently missing** — no error, no warning. The model answers as if nothing was set.

## Live evidence (reproduced against production)

```
$ curl -s -X POST https://gen.pollinations.ai/v1/chat/completions \
    -H "Authorization: Bearer sk_..." -H "content-type: application/json" \
    -d '{"model":"openai/gpt-5.4-nano","system":"You must always reply with exactly one word: BANANA. No other text.","messages":[{"role":"user","content":"hello?"}]}'
→ choices[0].message.content = "BANANA"                       # string works

$ # same request, system as an array:
    -d '{"model":"openai/gpt-5.4-nano","system":["You must always reply with exactly one word: BANANA. No other text."],"messages":[{"role":"user","content":"hello?"}]}'
→ choices[0].message.content = "Hello! 👋 How can I help you today?"   # system vanished

$ # same request, system as a number:
    -d '{"model":"openai/gpt-5.4-nano","system":12345,"messages":[{"role":"user","content":"hello?"}]}'
→ choices[0].message.content = "Hello! 👋 How can I help you today?"   # system vanished
```

## Root cause

1. `shared/schemas/openai.ts` — `CreateChatCompletionRequestSchema` is `.passthrough()` and declares no `system` field, so any JSON type passes validation.
2. `gen.pollinations.ai/src/text/requestUtils.ts:26-29`:

```ts
const messages = [
    ...(typeof system === "string" && system
        ? [{ role: "system", content: system }]     // ← everything else falls through
        : []),
    ...requestData.messages,
] as ChatMessage[];
```

`system` is destructured out of the body above, so non-string values are neither forwarded nor rejected — they simply disappear.

## Impact

- Clients porting from Anthropic-style APIs (where `system` is legitimately an array of content blocks) get fully functional-looking 200 responses with their behavioral instructions ignored — a silent correctness failure that is very hard to debug from the client side.
- Typos like `"system": {"text": "..."}` (object instead of string) behave identically: no error, no effect.
- The `GET /text` route types `system` as a string, so only the POST surfaces are affected — an inconsistent contract between documented sibling routes.

## Fix

Branch `solution12-system-field-validation` (commit `d0f984e`): `system` is declared on `CreateChatCompletionRequestSchema` as `z.string().nullish()` — string (and explicit null, treated as absent) pass, every other type now fails with a clean 400 at the route validator, and the extension parameter shows up in the generated OpenAPI docs for both POST routes. Two new schema tests (accept string/null, reject array/number/object/boolean). Full suite: 2798 passed. `/v1/messages` is unaffected: it converts its Anthropic `system` blocks into a proper system message before the chat schema ever sees the body.
