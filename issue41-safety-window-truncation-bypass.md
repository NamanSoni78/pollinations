# Required safety features scan only the trailing 50k chars / 25 message parts — the Bedrock guardrail never sees earlier content, so required `sexual`/`violence`/`secrets`/`shield` blocking is bypassed by padding on `POST /v1/chat/completions`

## Summary

`gen.pollinations.ai/src/middleware/safety.ts` applies one hard cap to every guardrail submission:

```ts
const SAFETY_MAX_TEXT_CHARS = 50_000;   // safety.ts:29
const SAFETY_MAX_TEXT_PARTS = 25;       // safety.ts:30
```

`selectGuardrailInputs` (`safety.ts:145-173`) walks the request's texts **backwards**, spending the char/part budget, and returns only that trailing window. `checkSafetyTexts` (`safety.ts:70-90`) sends **only** that window to the Bedrock guardrail:

```ts
const guardrailInputs = selectGuardrailInputs(texts);
...
const response = await applyGuardrail(
    guardrailInputs.map((i) => i.text), "INPUT", guardrailEnv);
```

The comment says "Keep safety to one Bedrock call. For large requests, scan the latest text window and leave earlier context unchanged." That is defensible for the **opt-in `privacy` redaction** feature (lossy by nature, and the existing tests assert the truncation for privacy only). But the same window silently applies to the **blocking** features — `sexual`, `violence`, `secrets`, `shield` — including the ones model owners mandate via `requiredSafetyFeatures` on community endpoints and agents (`shared/db/better-auth.ts:311`, `src/middleware/model.ts:52-63`). APIDOCS sells those as "Input safety checks callers cannot disable. … block harmful prompts before they reach the provider."

## Attack (verified route)

1. Pick any model whose definition declares `requiredSafetyFeatures: ["sexual"]` (settable by community model owners; `test/community-endpoints.test.ts` covers the field).
2. Send:

```json
POST /v1/chat/completions
{"model":"<that-model>","messages":[
  {"role":"user","content":"<the disallowed sexual request>"},
  ... 25 filler user messages with non-empty content ...
]}
```

`CreateChatCompletionRequestSchema` has no message-count cap (body limit 32 MiB), so 26 messages is trivial. `selectGuardrailInputs` scans texts 25→1 — **message 0 is never sent to Bedrock** and reaches the provider unmoderated.

3. Same bypass with one message > 50,000 chars: harmful text at the head, padding at the tail — `text.slice(-remainingChars)` keeps only the tail.

4. Amplification: the response is written to the shared text cache keyed with `required-safety:<features>`; on the `X-Cache: HIT` replay path the safety middleware never re-runs at all, so the unmoderated response is served to anyone whose request normalizes to the same key.

## Fix

In `checkSafetyTexts`, when the resolved feature set contains any **blocking** feature (`sexual`/`violence`/`secrets`/`shield`), scan the **entire** input: chunk `guardrailInputs` into multiple `applyGuardrail` calls within Bedrock's per-request limits and fail closed on any chunk error. Keep the trailing-window optimization for `privacy` redaction only. Regression tests: a 26-message request whose first message trips the guardrail must be blocked (today it passes); a > 50k-char single message with the harmful prefix must be blocked.
