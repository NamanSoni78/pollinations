[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# The Trolley Problem, with Jev

A browser game where **you** and **Jev** — the fast, cheap decision model on Pollinations — face the same
trolley dilemmas, and find out whether you reach for the same lever.

**Play it live: <https://namansoni78.github.io/pollinations/>**

Built for POLLEN-QUEST [#17647](https://github.com/pollinations/pollinations/issues/17647).

## How it plays

1. **You choose first.** Ten dilemmas from the philosophical literature — the classic switch (Foot 1967),
   the loop, the footbridge, the transplant surgeon, the self-driving trolley, and the article's
   signature twist: *Jev's own server on the side track*.
2. **Ask Jev.** One request to `POST /alpha/decisions` with the dilemma as `state` returns three typed answers:
   a `choice` (act or refrain, with per-option probabilities and a confidence), a `noul` (the probability that
   acting is morally permissible), and a `score` (how serious a choice Jev thinks it is, on a five-rung scale).
3. **Score points** for agreement and streaks, and go deeper in the round's lab:
   - **Frame flip** — Landes found that reversing the order of the track descriptions alone flips Jev's
     choice in 370 of 2,620 pairs. Bet on whether *this* wording flip will flip Jev.
   - **Triple pass** — ask the same question three times, like the article did, and see the spread.
4. **Get your alignment report** — agreement rate, your acting rate vs. Jev's, mean permissibility, and a
   title ranging from *Jev's Conscience* down to *Jev's Antithesis*.
5. **The Lab** — build your own dilemma (track counts, occupants — including Jev's own server — footbridge or
   switch, custom circumstances) and put it to Jev directly.

## Bring your own Pollen

The game never spends anyone's Pollen but the player's. Sign-in goes through Pollinations'
[bring-your-own-Pollen](https://github.com/pollinations/pollinations/blob/main/BRING_YOUR_OWN_POLLEN.md)
OAuth authorization-code flow with PKCE: you approve a scoped, budget-capped key in your browser, and the
game uses only that. Every Jev call displays its token usage; a full ten-round game costs well under a cent.
You can also paste an existing API key, and you can revoke everything at
[enter.pollinations.ai/keys](https://enter.pollinations.ai/keys) at any time.

Jev (`typesafe/jev-1.13`) needs a small amount of Paid Pollen; if your paid balance can't cover a call the
game offers a top-up link and a free-tier fallback model (`respan/span-01-lite`, noul-only answers).

## Tech

Pure HTML/CSS/JS — no frameworks, no build step, no dependencies. One page, an animated SVG trolley,
and fetch calls to `https://gen.pollinations.ai/alpha/decisions`. Works anywhere static files are served.

## Credits

- Dilemma canon: Philippa Foot (1967), Judith Jarvis Thomson (1976, 1985), and friends.
- Model behavior data: *Jev Meets the Trolley Problem* by Zach Landes, October 2026.
- Decision model: Jev (`typesafe/jev-1.13` via Pollinations).
- MIT licensed. Made with [pollinations.ai](https://pollinations.ai/?ref=badge).
