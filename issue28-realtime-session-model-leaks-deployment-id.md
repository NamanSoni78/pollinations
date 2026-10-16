# Realtime sessions leak the internal Azure deployment id in session.model — "gpt-realtime-2-1" is not a name any caller can request

## Summary

On the non-transcription realtime routes, the forwarded `session.created` / `session.updated` events report the **Azure deployment id** in the top-level `session.model`:

```
wss://gen.pollinations.ai/realtime?model=openai/gpt-realtime-2.1
→ session.created.session.model = "gpt-realtime-2-1"

wss://gen.pollinations.ai/realtime?model=openai/gpt-realtime-2.1-mini
→ session.created.session.model = "gpt-realtime-2-1-mini"
```

The caller asked for `openai/gpt-realtime-2.1` (or its alias `gpt-realtime-2`); the session answers with the deployment name — which does not exist in `/models`, cannot be requested, and is not the identity the platform prices or bills. Clients that key cost tracking or model routing off the session's model field (LiteLLM-style proxies, usage dashboards) see an unknown model.

Every other surface in the platform rewrites provider ids to the registry's public identity, with comments stating the principle — "The registry owns public model identity: the provider answers with its own dated build id, which is not a name callers can request" (`text/decisions/handler.ts`), the media adapter rewrites `model` on re-entry, the transcription paths rewrite `audio.input.transcription.model` **both directions** (`rewriteLiveTranscriptionModel`), and the Scribe session is built with the public name outright. The gpt-realtime session events are the one place the internal name leaks through.

## Evidence

Live against `gen.pollinations.ai/realtime` with a paid key (full `session.created` captured per model):

```
openai/gpt-realtime-2.1       → session.model = "gpt-realtime-2-1"        (deployment)
openai/gpt-realtime-2.1-mini  → session.model = "gpt-realtime-2-1-mini"   (deployment)
alias gpt-realtime-2           → session.model = "gpt-realtime-2-1"        (same leak)
microsoft/mai-transcribe-2-streaming → no top-level session.model at all;
      its audio.input.transcription.model IS rewritten to the public name  (correct)
elevenlabs/scribe-v2-realtime → session built with "elevenlabs/scribe-v2-realtime" (correct)
```

Probe script: `scripts/bug-verify-wave8-realtime-identity.mjs`.

Worker-level repro (`test/realtime-session-model-identity.test.ts` in the solution branch): the provider's `session.created` with `session.model: "gpt-realtime-2-1"` must reach the client as `openai/gpt-realtime-2.1` — RED on stock `main` (`expected 'gpt-realtime-2-1' to be 'openai/gpt-realtime-2.1'`), green after the fix for both `session.created` and `session.updated`.

## Root cause

- `gen.pollinations.ai/src/routes/realtime.ts` — the upstream→downstream `forwardMessage` for the non-transcription models passes the provider's session events through untouched (`transform: undefined`); the model-rewrite machinery (`rewriteLiveTranscriptionModel`) only covers the transcription routes' `audio.input.transcription.model` field, never the top-level `session.model`.

## Fix

Branch `solution28-realtime-session-model-identity` (@ `e4ddf8c9`):

- New `rewriteSessionModel(data, deployment, publicModel)` beside the existing rewrites: when the provider's session event names the deployment, it is replaced with the resolved public model (`c.var.model.resolved`, e.g. `openai/gpt-realtime-2.1`); any other spelling passes through untouched rather than being guessed at.
- Wired into the upstream→downstream transform for the non-transcription routes; transcription sessions (which have no top-level `session.model`, verified live) keep their existing both-direction transcription-model rewrite.
- The two tests that pinned the leak verbatim (`"proxies OpenAI-compatible realtime WebSockets on both public routes"`, `"forwards the initial Azure session event after listeners are attached"`) now assert the public identity.

Full suite green (2874 passed), `tsc` clean, biome clean.
