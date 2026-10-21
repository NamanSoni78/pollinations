# Agent-run tokens authenticate to media with `type: "secret"` — a delegation credential handed to generated/sandboxed code gets full DELETE authority over every item the user ever published, because media's only credential-tier check is `type === "secret"`

## Summary

media's DELETE guard is a single tier check:

```ts
// media.pollinations.ai/src/index.ts:832-837
// Publishable keys ship inside public clients — anyone holding one
// could delete the owner's published media, so deletion is
// secret-key only.
if (auth.type !== "secret") {
    return c.json({ error: "Deleting media requires a secret (sk_) API key" }, 403);
}
```

But agent-run tokens inherit the **parent key record unchanged**, including `type`:

```ts
// shared/auth/api-key.ts:276-283
// The token carries the parent key's permissions unchanged; the owner
// limits what an agent can do by limiting the key it is called with.
return { ...parent, agentRun: claims };
```

and enter's key-lookup endpoint (which media authenticates against) returns the parent record with `type: "secret"` for a run token (asserted by `enter.pollinations.ai/test/account-key.test.ts:55-90`).

So: a user runs a code agent; the `agentrun_…` token is passed **into the sandboxed/generated execution** — the least-trusted context in the platform's own threat model. Any code running there (or anyone who exfiltrates the token from it, e.g. via the prompt-injection surface) can call `DELETE /media/:id` for **every item the user ever published**, because to media it is indistinguishable from the user's `sk_`.

The comment on the delete guard shows exactly the reasoning that should extend here: pk_ keys are excluded because they "ship inside public clients" — i.e. credentials likely to leak from semi-trusted code. Run tokens are that class: delegated, exposed to generated code, and (unlike sk_ keys) **cannot be revoked** (`shared/auth/api-key.ts:204-206` explicitly makes agent-run and session tokens Bearer-only for this reason).

## Fix

Distinguish run tokens in the key-lookup response (media already receives the full record): either return a distinct `type`/flag (e.g. `agentRun: true` is already on the auth result — surface it through `/account/key`), and require a plain `sk_` (no `agentRun`) for DELETE — mirroring the existing pk_ exclusion. Upload/list/tags can stay permitted for run tokens; deletion is the destructive authority worth fencing.
