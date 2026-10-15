Fixes #17527

# `polli harness opencode` on OpenCode 2.0 (and still on 1.x)

`polli harness opencode on` used to enable `opencode-pollinations-plugin` — a 1.x plugin that OpenCode 2.0.29 rejects outright ("Plugin must export a default definition with an id and an effect or setup function"), so no Pollinations models ever appeared. It now registers a **`pollinations` provider** instead, and the whole change lives in `packages/polli-cli`.

## What `on` writes

The provider block uses the V1 shape (`provider` table, `npm` + `options`) that OpenCode 2.x still reads and normalizes in memory — one config file serves both generations:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "pollinations": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Pollinations",
      "options": {
        "baseURL": "https://gen.pollinations.ai/v1",
        "apiKey": "sk_… dedicated key …"
      },
      "models": { /* the 30 tool-calling models `on` already fetches */ }
    }
  },
  "model": "pollinations/openai/gpt-6-sol"
}
```

- **Key placement is the load-bearing detail**: the dedicated key lives in the provider's `options.apiKey` because that is the one credential location **both generations read**. Verified on real binaries: OpenCode 1.19.0 accepts it; OpenCode 2.0.29 accepts it; 2.0.29 does **not** pick up the V1 `auth.json` entry (`{"pollinations":{"type":"api","key":…}}`) the plugin era relied on — with it, 2.0.29 sends unauthenticated requests and Pollinations answers `401`.
- **Running `on` again replaces an earlier plugin setup**: the plugin entry is dropped from `plugin`/`plugins`, the `pollinations/enter/<model>` default becomes `pollinations/<model>`, and the plugin's stored key is reused for the provider (verified migrating a real legacy setup on 2.0.29 — "Reusing the Pollinations key already stored for OpenCode").
- The restart hint now points at the media tools: `polli mcp install opencode --all` (verified: installs `pollinations, ask-jev, ffmpeg, exa, composio, computer`).
- `off` restores the config byte-for-byte, or — when the file was edited since `on` — strips only the provider, our default model, and leftover plugin entries, leaving other providers and settings untouched.
- `--model <id>` still picks the default; `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR` still redirect the file; JSONC configs keep working.

## Terminal evidence (real binaries, real Pollinations traffic)

OpenCode **1.19.0** (`~/.opencode/bin/opencode`) and **2.0.29** (`npm i @opencode/cli`), separate `$HOME`s, each with a pre-existing user config (`{"autoupdate": true, "custom_marker": "keepme-…"}`).

```
$ opencode --version
1.19.0

$ polli harness opencode on
Created API key "polli-harness-opencode" for OpenCode.
OpenCode now uses Pollinations (model: openai/gpt-6-sol).
Restart OpenCode, then pick a Pollinations model with /models. Add the media tools with: polli mcp install opencode --all

$ opencode models | grep pollinations | head -3
pollinations/deepseek/deepseek-v4-flash
pollinations/meta/llama-3.3-70b-instruct
pollinations/minimax/minimax-m3

$ opencode run --model pollinations/openai/gpt-6-sol "Reply with exactly one word: VERIFIED1X"
> build · openai/gpt-6-sol
VERIFIED1X

$ polli harness opencode off
OpenCode: original config restored.
$ sha256sum ~/.config/opencode/opencode.json   # identical before `on` and after `off`
```

Same sequence on **2.0.29**, this time from a legacy plugin setup (`plugin: ["opencode-pollinations-plugin"]`, `model: "pollinations/enter/openai/gpt-6-sol"`, key in the plugin's config):

```
$ opencode --version
opencode v2.0.29

$ polli harness opencode on
Reusing the Pollinations key already stored for OpenCode.
OpenCode now uses Pollinations (model: openai/gpt-6-sol).

$ # config after: plugin entry gone, provider registered, key reused, custom_marker kept
$ opencode run --model pollinations/openai/gpt-6-sol "Reply with exactly one word: MIGRATED"
> build · openai/gpt-6-sol
MIGRATED
```

Tool use was exercised too (`opencode run` asked to create and read back a file — patch + read + correct answer on both versions), and the wallet was billed through gen.pollinations.ai for these runs. Also verified on 2.0.29 that a JSONC config with comments round-trips `on`/`off` byte-for-byte, and `polli mcp install opencode --all` writes its six servers into the same config.

## Tests

`opencode.test.ts` rewritten in the same style (16 tests): provider block + key + default model from scratch; existing providers/plugins/settings preserved; JSONC precedence; invalid config refused; **legacy plugin replacement (incl. key reuse)**; legacy setup reported unconfigured; byte-for-byte restore; strip-only-ours after edits (other providers survive); re-run switches model; edits between runs kept; `OPENCODE_CONFIG` / `OPENCODE_CONFIG_DIR`; missing credential → unconfigured; unavailable binary → no files touched. Full `packages/polli-cli` suite: **367 passed, 1 skipped**; `tsc` error set unchanged vs `main` (all pre-existing); biome clean. `@pollinations/cli` bumped to **0.1.49**; README / SKILL.md / CODING_HARNESSES.md updated.

Branch: `quest/17527-opencode-2-0` (fork), diff 6 files +251/−172.
