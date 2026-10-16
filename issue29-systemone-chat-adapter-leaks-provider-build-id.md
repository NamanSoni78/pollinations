# Decision models' chat adapter leaks the provider's dated build id in `model` — "jaredpalmer/kev-4b-20260924" is not a name any caller can request

## Summary

On `/v1/chat/completions`, the decision models (`typesafe/jev-1.13`, `jaredpalmer/kev-4b`, `liquid/d1`, `perplexity/pplx-decider-v1.1-27b`, `microsoft/microsoft-decision-1`, `openai/gpt-6-luna-decisions`, and their fallback targets) echo the **provider's own model string** in the response body and in **every streamed chunk**:

```
POST /v1/chat/completions  { "model": "jaredpalmer/kev-4b", ... }
→ response.model = "jaredpalmer/kev-4b-20260924"        (OpenRouter's dated build id)

POST /v1/chat/completions  { "model": "typesafe/jev-1.13", ... }
→ response.model = "typesafe/jev-1.13-20260917"         (dated build id)
```

The same request through the native `POST /alpha/decisions` (and its `/v1/systemone` alias) correctly returns `model: "jaredpalmer/kev-4b"`. So the two entry points for the same model disagree, and only the chat one leaks.

The leaked ids are build-stamped names that:

- do not exist in `/models` and cannot be requested through the registry;
- change without notice when the provider ships a new build (jev-1.13 → jev-1.14 already happened on 2026-10-15), silently breaking clients that pin, log, or route on `model`;
- after a fallback, name the *other* route's build — the caller requested `microsoft/microsoft-decision-1` (Vercel primary), the response can carry the OpenRouter build stamp of the same model, or vice versa, with nothing telling the client which route served it.

The platform states the principle in code: `text/decisions/handler.ts` — *"The registry owns public model identity: the provider answers with its own dated build id, which is not a name callers can request"* — and the native route re-keys accordingly. `usageHeaders` in `text/handler.ts` makes the same argument for attribution: *"it wins over the name the provider reports for itself... which after a fallback names the wrong party's model"*. The chat adapter's `callSystemOne` is the one place the provider's string still reaches the client.

## Evidence

Worker-level repro (`test/text/decisions.test.ts` in the solution branch, red-first): the OpenRouter mock answers with the dated build id `jaredpalmer/kev-4b-20260924` (the same shape the existing "Kev answers on chat completions" test already mocks — it pins the content but never asserts `model`). On stock `main`:

- non-streaming: `expected 'jaredpalmer/kev-4b-20260924' to be 'jaredpalmer/kev-4b'`
- streaming: the first and final usage chunks both carry `model: "jaredpalmer/kev-4b-20260924"`

Both RED on stock, both green after the fix. The existing tests' own mocks (`jaredpalmer/kev-4b-20260924`, `typesafe/jev-1.13-20260917`) document that these dated ids are what the providers actually answer with.

## Root cause

- `gen.pollinations.ai/src/text/systemOneClient.ts` — `callSystemOne` builds the `ChatCompletion` with `model: result.model`, i.e. the provider's self-reported string from the `SystemOneResponse`. `completionToChatStream` then copies that `model` into every chunk it replays. The native `/alpha/decisions` handler re-keys to `c.var.model.resolved` before returning, so only the adapter path leaks.

## Fix

Branch `solution29-systemone-chat-model-identity` (@ `27041c2d`):

- `callSystemOne` now sets `model: options.requestedModel ?? result.model`. `requestedModel` is set by `resolveModelConfig` and carries the canonical registry id of the candidate that ran — the requested listing on the primary path, and the fallback target after a rescue — matching exactly what `servedModelId`/`x-model-used` reports for every other chat model.
- Two red-first tests cover the non-streaming body and every streamed chunk (both `stream: false` and `stream: true`).

Full decisions suite 21 passed, related suites (systemOneClient, publicChat, static-provider-fallbacks) 108 passed, full gen suite 2875 passed, biome clean.
