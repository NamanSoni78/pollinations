Fixes #17246

# Pollinations plugin for Minecraft servers

Server owners add Pollinations to their server with one plugin — drop the jar, set your own API key in `config.yml`, done. Every player on the server can chat with AI villagers, generate map art, and talk to personas — billed to the owner's own Pollen balance.

## What's inside

```
apps/minecraft-pollinations/
├── src/main/java/io/pollinations/minecraft/   18 classes
├── src/test/java/                             22 JUnit tests
├── README.md                                  install steps, commands, personas, security note
└── .github/workflows/build.yml                 mvn package CI
```

## Commands

| Command | What it does |
|---|---|
| `/ai <message>` | Chat with the AI (persona-selectable, 10-turn memory) |
| `/draw <prompt>` | Generate an image onto a **filled map** — real 128×128 MapPalette rendering the player can hold and frame |
| `/pollinations key <sk_...>` | Set the owner's API key (masked in logs) |
| `/pollinations models` | List text/image models |
| `/pollinations status` | Key + endpoint status |
| Right-click a named villager | Persona chat — villagers you name (e.g. "librarian_merlin") become characters with their own prompts and memory |

## Server-owner first

- **One key, one config.** `plugins/Pollinations/config.yml` — set `api-key`, restart, everything works. The plugin's README states plainly that the server key spends the owner's Pollen by design (that's the quest's intent), with per-player cooldowns (default 3 s) to protect it.
- **Paper / Spigot / Folia.** Adventure components on Paper, legacy strings on Spigot, class-presence detection picks the path; async HTTP with results delivered via the Bukkit scheduler keeps the main thread clean.
- **Nothing shaded.** `paper-api` provided-scope + gson/adventure serializers — the jar is 45 KB and conflicts with nothing.

## Verified

- `mvn test` — 22 JUnit tests green: map palette conversion (transparency, gradients, 128×128 scaling — the hardest part of map art), persona parsing/lookup, conversation memory caps, cooldowns, error mapping, key masking, model list wrapping.
- `mvn package` — `minecraft-pollinations-1.0.0.jar` (44.6 KB) builds with Java 21.
- **Live smoke test** against `gen.pollinations.ai` with a real Pollen key: chat completion, 104 text models + 20 image models listed, and a 1024×1024 JPEG converted to 16,384 map bytes / 53 colors — the exact path `/draw` uses in-game.

## App submission

- App URL: the plugin's release/download page (built jar + README install steps)
- Quest field: `#17246`
