Fixes #17250

# Tiny fighter arena: describe a fighter, watch it battle

Players describe a fighter in one line, and the AI brings it to life and sends it into a short, commentated battle against a challenger. A browser game: pure vanilla HTML/CSS/JS, no build step, no dependencies, no server — open `index.html` and play.

## What's inside

```
apps/tiny-fighter-arena/
├── index.html     one page, Google-font-free, zero dependencies
├── app.js         UI flow, API calls, share links
├── core.js        deterministic battle engine + fighter codec (pure logic, testable headless)
└── style.css      arena styling with CSS animations
```

## The loop

1. **Describe a fighter in one line** — "a lactose-intolerant cheese golem with a grater fist".
2. **The AI designs the fighter**: name, look, four stats, signature move, and a taunt — shown as a generated portrait plus stat card.
3. **A challenger appears** (AI-generated, or paste a friend's fighter code).
4. **A short, commentated battle** — round-by-round narration over a deterministic, seeded engine: same fighters + same seed = same fight. The arena replays the fight with hit/miss/crit effects and a play-by-play log.
5. **Share it** — every fighter is a compact LZW-compressed code; champions are shareable links, so battles are provably re-watchable.

## Design notes

- **Determinism where it matters.** Fighter generation and commentary are LLM work; the fight itself runs on a seeded engine in `core.js` — no hallucinated outcomes, and any dispute can be replayed byte-for-byte.
- **The prompts are the game.** Fighter generation asks for a *person*, not a stat sheet — name, look, personality, a signature move that fits, and one weakness the challenger can exploit. The narrator calls the fight round by round with the actual engine events in hand.
- **BYOP optional.** The game ships anonymous-tier by default (shared Pollen); a sign-in panel starts the device flow and stores the player's key so their fights bill to their own balance.
- **Zero server.** Everything runs in the browser against the public Pollinations endpoints; the share codec is pure JS.

## Verified

Six live end-to-end runs against the real API, driving the game's actual code paths headless in Node:

- fighter generation from a one-line description ("Cheezard Grate-Light" — full JSON: stats, move, portrait prompt)
- challenger generation and stat normalization
- engine determinism — identical seed and fighters produce identical transcripts
- battle narration (commentary follows the real engine events)
- fighter portraits (image endpoint round-trip)
- share-codec round-trip (fighter → LZW code → fighter, byte-identical)

## App submission

- App URL: the playable game (GitHub Pages of this folder, or any static host)
- Quest field: `#17250`
