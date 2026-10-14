Fixes #17245

# An agent that reviews a pull request and pushes a fix

PullFix is a Pollinations code agent that takes a PR link, reviews the change with the code around it, and pushes a proposed fix to a branch — so a maintainer only reads a short review and a ready diff.

## How it works

```
PR link ─▶ fetch PR + diff + surrounding code ─▶ one gpt-6.1-sol review ─▶ short review + fix branch
            (GitHub REST API, deterministic)        (structured JSON)        (Git Data + Merges API)
```

- **Reading is agent work, not model work.** The agent fetches PR metadata, the unified diff, and each changed file's content at the PR head (line-numbered; hunk-focused for large files) from the public GitHub REST API. The model never browses.
- **One model call.** `openai/gpt-6.1-sol` reviews and answers a strict JSON contract: verdict, severity-ranked findings, and complete fixed file contents only for mechanical issues. The cost at catalog prices is printed with every review.
- **The push is deterministic.** A `pr-fixer/<number>` branch is created in a repository the caller controls, the PR head is merged in via GitHub's merge API, and one commit with the patched files lands on top — the diff between the two is exactly the proposed fix. A file is only patched when a finding names that file.
- **Both request shapes work** — call it through `/v1/chat/completions` or `/v1/responses`.

## Demonstrations on real PRs (with the cost of each review)

| PR | Verdict | Findings | Review cost |
|---|---|---|---|
| [pollinations#17422](https://github.com/pollinations/pollinations/pull/17422) — sdk: return stored media URL from videoUrl | clean | — | 0.1835 Pollen (90,870 in / 175 out) |
| [pollinations#17366](https://github.com/pollinations/pollinations/pull/17366) — image: clamp qwen size to Alibaba limits | clean | — | 0.0212 Pollen (9,222 in / 279 out) |
| [pollinations#17415](https://github.com/pollinations/pollinations/pull/17415) — cli: name Gemini TTS output by WAV type | clean | — | 0.1079 Pollen (53,380 in / 114 out) |
| [pollinations#12332](https://github.com/pollinations/pollinations/pull/12332) — forehead-detective app | issues | 3 major: stale-round race in `runSingleTurn`; `askAi` commits responses without a round check; autoplay retries failures without bound | 0.1114 Pollen (51,169 in / 911 out) |
| [pollinations#12639](https://github.com/pollinations/pollinations/pull/12639) — Robot DJ app | issues | 2 major, 1 minor: crossfade deck reloaded mid-transition; duplicate track IDs from dropped folders; running UI hides auth recovery | 0.0927 Pollen (41,851 in / 902 out) |
| [NamanSoni78#11](https://github.com/NamanSoni78/pollinations/pull/11) — fork demo PR with a deliberately buggy helpers file | issues | 4: infinite retry loop; truncate off-by-one; `capitalize("")` crash; word count inflated by untrimmed whitespace | 0.0133 Pollen (1,331 in / 1,067 out) |

The last run pushed the full loop: the fix branch [`pr-fixer/11`](https://github.com/NamanSoni78/pollinations/tree/pr-fixer/11) contains one commit whose diff against the PR head is exactly the four corrections. The race-condition findings produced **no** auto-fix by design — those need design decisions, and the agent says so instead of patching around them.

Total spend for six reviews: ≈ **0.53 Pollen**.

## What worked, what blocked, what agents would need

**Worked.** The one-call structured-JSON review is reliable and cheap; findings cite real lines; the honest "clean" on well-made PRs is the important behavior. Deterministic context assembly is what makes that possible. The push path — branch, merge PR head, one commit on top — produces a genuinely ready diff, verified end to end.

**Blocked / worked around.** The platform gives a code agent the caller's Pollen and MCP tools, but no way for the agent owner to hold a GitHub credential — so pushes use a caller-provided fine-grained PAT scoped to one fork (the Composio connector route bills the caller's connection and is the platform-native alternative). The `respond()` runtime has no filesystem, so `git apply`/CI verification of the fix is out of scope; the commit is constructed through the Git Data API instead. GitHub anonymous reads are rate-limited to 60/h — the agent degrades gracefully, and any token lifts it.

**Agents would need:** an owner-scoped GitHub identity (or first-class Composio tool use inside code agents); a sandbox to compile/lint the proposed fix before pushing; and a long-run budget for a review-every-new-PR watch — at ≈0.1–0.2 Pollen per review, cost is already not the blocker.

## Tests

`node --test agent.test.ts` — thirteen tests: link/JSON input parsing, hunk-range extraction, context selection, prompt assembly, model-output parsing, usage/cost math, the patch-only-with-matching-finding rule, review rendering, and the full flow twice (issues+push, and clean verdict).

Source: `apps/agent-pr-fixer/`.
