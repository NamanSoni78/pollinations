# Polli Discord bot: synchronous `requests.get` on the event loop in the LaTeX rendering path — one math-heavy reply freezes the entire bot (gateway heartbeat misses → disconnect) for up to 10 s per equation block, unbounded block count

## Summary

`apps/polli/src/discord/media.py:131-142` renders LaTeX formulas by calling a third-party HTTP API **synchronously**:

```python
def _latex_to_svg(formula: str) -> bytes:      # media.py:131
    if not LATEX_AVAILABLE:
        return b""
    try:
        encoded = urllib.parse.quote(formula, safe="")
        url = f"https://math.vercel.app?color=white&from={encoded}.svg"
        response = requests.get(url, timeout=10)   # ← sync call
        response.raise_for_status()
        return response.content
    except Exception as e:
        logger.error(f"Failed to fetch SVG for LaTeX: {e}")
        return b""
```

`_latex_to_svg` is called by `convert_latex_to_png()`, which is `async` (`media.py:160+`) — so the blocking `requests.get` runs **on the event loop**, not in a thread. It is invoked from `send_long_message` (`apps/polli/src/bot.py:1579-1593`) for every `$$…$$` / `\[…\]` / fenced-`latex` block in **every bot reply**, **serially**, with **no cap on the number of blocks per message**:

```python
latex_blocks = BLOCK_LATEX_PATTERN.findall(modified_text)
for idx, latex_expr in enumerate(latex_blocks):          # bot.py:1579 — unbounded
    ...
    latex_buffer, success = await convert_latex_to_png(latex_expr)  # ← blocks the loop inside
```

`cairosvg.svg2png` (`media.py:144-151`) then runs the CPU-bound SVG→PNG conversion on the loop as well.

## Failure scenario

1. Any user asks a math question ("derive the Navier–Stokes equations step by step"). Models happily emit replies with dozens of display-equation blocks.
2. Each block serially blocks the event loop for up to `timeout=10` seconds when `math.vercel.app` is slow or hanging. 20 blocks = up to 200 s of frozen event loop.
3. While frozen: the discord.py gateway heartbeats are not answered → **Discord disconnects the bot**; all concurrent conversations across all guilds stall; the GitHub webhook server and the embedded API server (same loop) stall; every other in-flight command dies.
4. Trivially repeatable by any user, no permissions needed — the trigger is the model emitting equations, which is the feature working as designed.

The bot already carries an `aiohttp` client elsewhere (`web_scraper`, GitHub integration), so there is no dependency obstacle to the fix.

## Fix

- Replace `requests.get` with `aiohttp` (a session pattern already exists in the codebase) or wrap the sync call: `await asyncio.to_thread(_latex_to_svg, formula)`.
- Move `cairosvg.svg2png` off the loop the same way (`asyncio.to_thread`).
- Cap rendered blocks per reply (e.g. first 5, rest fall back to the existing ```latex fenced fallback) and add a small LRU cache keyed on the formula string — repeated equations are the common case in math threads.

All three are mechanical; the first alone removes the remote-triggerable bot-wide freeze.
