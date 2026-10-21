# Polli bot: the GitHub-webhook mention path never passes `tool_context` — the system prompt says "ADMIN MODE, all tools available" while every privileged handler correctly reads `_context=None` and refuses; `discord_search` always errors, and `subscribe` inserts rows keyed to `user_id=0`

## Summary

When the bot is mentioned through the GitHub webhook (issues/PRs/comments on GitHub, not Discord), `process_mention` calls the agent loop **without `tool_context`** (`apps/polli/src/integrations/webhook_server.py:311-317`):

```python
result = await pollinations_client.process_with_tools(
    user_message=user_message,
    discord_username=f"github:{github_user}",
    thread_history=None,
    image_urls=[],
    is_admin=is_admin,
    # ← no tool_context
)
```

But the client builds the system prompt from `is_admin` regardless (`apps/polli/src/ai/client.py:203-210`):

```python
system_content = get_tool_system_prompt(is_admin=is_admin, ...)
if is_admin:
    system_content += "\n\n## ADMIN MODE\nUser is admin. All tools available. ..."
```

and the tool executor only injects context when it exists (`client.py:747-748`):

```python
if tool_context:                      # ← None here
    args["_context"] = tool_context_for_call
```

so every handler falls back to its defaults — `is_admin=False` (`handlers.py:54-59`) — regardless of the actual actor.

## Consequences (fails closed, but wrong in three ways)

1. **Admin phantom mode.** A configured GitHub admin mentions the bot → the prompt promises all tools → every privileged call returns "requires admin permissions. Ask a team member with admin access!" → the model retries and re-plans, **burning extra LLM iterations per turn** (up to the 500-iteration loop cap), then reports failure. The feature is simply broken from GitHub, and it costs more the harder it fails.
2. **`discord_search` is unconditionally broken on this path.** It requires `_context` (`src/discord/search.py:658-659`) → `"No context provided"` error, every time, even for read-only lookups that need no privileges.
3. **Garbage subscription rows.** `github_issue(action="subscribe")` runs with the default `user_id=0` (`handlers.py:41`), inserting subscription records that can never be matched to a real user or notified — silent data pollution in the bot's database.

This is a correctness bug that fails *safe* — no privilege is gained, only lost — plus a data-hygiene leak and wasted API spend.

## Fix

Build the context in `process_mention` from the actor the webhook already authenticated, and pass it through:

```python
tool_context = {
    "is_admin": is_admin,
    "is_collaborator": is_collaborator,          # if derivable from repo perms
    "user_id": actor_id,                          # numeric GitHub id, not 0
    "user_name": f"github:{github_user}",
    "github_actor": github_user,
    # no channel/guild keys — Discord-scoped tools should be filtered out instead of erroring
}
result = await pollinations_client.process_with_tools(
    ..., tool_context=tool_context)
```

Additionally, filter the Discord-only tools (`discord_search` and anything reading `channel_id`/`guild_id`) out of the tool list for webhook-originated turns rather than letting them error at call time — cheaper, and it stops the retry loop before it starts.
