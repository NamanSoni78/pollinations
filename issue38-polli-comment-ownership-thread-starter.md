# Polli bot: GitHub comment edit/delete ownership is keyed to whoever *started* the Discord thread, not who is asking — any thread participant can make the bot edit or delete another user's comments, and every comment in a thread is attributed to the starter

## Summary

The tool context freezes one identity per thread — the thread **starter**:

```python
# apps/polli/src/bot.py:1334
tool_context = {
    ...
    "user_id": user.id,
    "user_name": str(user),
    "reporter": session.original_author_name,   # ← the starter, frozen for the thread's life
    ...
}
```

The GitHub handlers adopt it as the acting identity for comment operations (`apps/polli/src/integrations/github/handlers.py:66`):

```python
reporter = _context.get("reporter", reporter)
```

and ownership of `edit_comment` / `delete_comment` is decided by a **display-name substring match** against the attribution stamp (`apps/polli/src/integrations/github/client.py:345-352, 366, 416`):

```python
def _verify_comment_ownership(self, comment_body: str, requester: str) -> bool:
    # Match the exact format used in add_comment()
    return f"**From:** `{requester}`" in comment_body
```

Because `reporter` is the starter for **everyone** who posts in the thread, the check passes for participants the comment does not belong to.

## Attack scenario

1. Ana starts a thread and asks Polli: "comment on issue #100 saying 'LGTM'" → the bot posts on GitHub with the stamp `**From:** \`Ana (@ana)\``.
2. Bo — any member who can post in that thread — replies: "actually delete that comment you made on #100".
3. The handler receives `reporter = Ana` → `_verify_comment_ownership` sees Ana's stamp → **Ana's comment is deleted on Bo's request**.
4. Same for edits: Bo can rewrite the text of comments Ana created. New comments Bo requests are likewise stamped `From: Ana` — misattribution on a public repo, and a mess for audit trails.

Secondary holes in the same mechanism:

- The inline-mention path (`bot.py:1117-1133`) never sets a `reporter` at all → its comments are attributed to the literal fallback `"Discord User"`.
- The check is a substring test on display names — two users named "Alex" satisfy each other's check even in threads where the starter *is* the owner.
- `edit_comment`/`delete_comment` are in `ADMIN_ACTIONS` in the handler (`handlers.py:73-91`) but that gate reads `is_admin` from the *starter's* frozen context too, and in any case the ownership check is the layer that actually decides.

## Fix

- Pass the **current message author** as the comment requester — `format_discord_identity(user)` / `user_id` from the message being processed — instead of `session.original_author_name`. Thread history remains keyed to the starter; only the acting identity for comment operations should follow the speaker.
- Compare stable IDs, not display-name substrings: include the Discord user id in the stamp (e.g. `**From:** \`Ana (@ana, 1234567890)\``) and match on that, or keep a server-side `comment_id → discord user_id` map instead of parsing GitHub comment bodies.
- Give the inline path the same requester plumbing so its comments stop being attributed to "Discord User".
