# GET /text `voice` param leaks into provider request bodies — one documented param, three behaviors

## Summary

`GET /text/{prompt}` exposes a `voice` query parameter (it appears in the generated OpenAPI spec). The gateway never consumes it for non-audio models: the value is forwarded **verbatim as a top-level field in the upstream provider request body**. For audio-output models it is sent **twice** (top-level `voice` *and* `audio.voice`). For Responses-API models it is **silently dropped**. One documented parameter, three inconsistent behaviors, and a stray field in every provider request made with it.

## Live evidence (reproduced against production)

```
$ curl -s "https://gen.pollinations.ai/openapi.json" | jq '.paths["/text/{prompt}"].get.parameters[] | select(.name=="voice")'
{ "name": "voice", "in": "query", "schema": { "type": "string" } }   # documented param

$ curl -s "https://gen.pollinations.ai/text/Reply%20with%20just%20OK?voice=banana" -H "Authorization: Bearer sk_..."
→ 200 "OK"        # default model (Azure gpt-5.4-nano): forwarded, provider ignores it

$ curl -s "https://gen.pollinations.ai/text/Reply%20with%20just%20OK?model=openai/gpt-5.3-codex&voice=banana" -H "..."
→ 200 "OK"        # Responses-API model: silently dropped

$ curl -s "https://gen.pollinations.ai/text/Reply%20with%20just%20OK?model=openai/gpt-audio-1.5&voice=nova" -H "..."
→ 200 audio/mpeg  # audio model: consumed via audio.voice, top-level copy still forwarded
```

The forwarded-body part is a code trace (verified end to end below); the Azure/Fireworks providers currently tolerate the stray field, so nothing user-visible breaks **today**.

## Root cause

1. `schemas/text.ts:53` — `voice: z.string().optional()` parses the query param.
2. `text/requestUtils.ts` `getSimpleTextRequestData` spreads all remaining query options into the request data.
3. `text/handler.ts` `prepareRequestParameters` only touches `voice` when the model has audio output — it never strips it otherwise, and for audio models it sets `audio: { voice }` **while keeping the top-level copy**.
4. `text/genericOpenAIClient.ts` builds the upstream body from `cleanNullAndUndefined({ model, messages, ...cleanedOptions })` — `voice` survives into the JSON body.
5. `text/responses/chatRequest.ts` only maps known Chat fields, so the Responses adapter drops it.

```
upstream body sent today for GET /text/hi?voice=banana (non-audio model):
{ "model": "openai/gpt-5.4-nano", "messages": [...], "voice": "banana" }
                                                  ^^^^^^^^^^^^^^^^^^ stray field
```

## Impact

- Providers that strictly validate request bodies (OpenAI-style `Unrecognized request argument supplied: voice`) would 400 every request carrying `voice` — any strict provider added to the fleet breaks this param immediately.
- Request-body pollution confuses provider-side debugging, A/B logs, and token accounting.
- The audio path ships the value twice; the Responses path ignores it — callers cannot reason about what `voice` does.

## Fix

Branch `solution10-text-voice-param` (commit `8db43bd`): `prepareRequestParameters` now always destructures the top-level `voice` away — folding it into `audio.voice` for audio-output models (preserving all existing voice semantics) and dropping it for every other model. Four new unit tests cover the fold, the default voice, client-provided `audio` overrides, and the pcm16 streaming format. Full suite: 2800 passed.
