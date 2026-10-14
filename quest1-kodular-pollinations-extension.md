Fixes #17248

# Pollinations extension for Kodular

Kodular builders add Pollinations to their apps with one extension — `io.kodular.pollinations.aix` — and their users bring their own Pollen. Blocks cover chat, text, images, speech (TTS + STT), vision and the full BYOP device flow, so no builder ever ships a shared key and nobody's key runs dry.

## What's inside

```
apps/kodular-pollinations/
├── README.md            install, blocks reference, BYOP walkthrough, testing notes
├── src/                 Java 7 extension source (no external dependencies)
├── dist/io.kodular.pollinations.aix   built, tested extension package
├── sample/PollinationsDemo.aia        sample project with the .aix bundled
└── .github/workflows/   build + package CI
```

## Blocks surface

| Group | Blocks |
|---|---|
| Chat & text | `Chat`, `ChatWithSystem`, `GenerateText`, streaming-free one-shot calls with `GotResponse` / `GotError` events |
| Images | `GenerateImage(prompt, model, width, height, seed)` → `GotImage(localPath)`, plus `ImageUrl` for URL-only mode |
| Speech | `TextToSpeech(text, voice, format)` → `GotAudio(path)`; `SpeechToText(path, model)` → `GotTranscription(text)` |
| Vision | `DescribeImage(imagePath, prompt, model)` — image understanding through the multimodal endpoints |
| BYOP | `StartDeviceLogin` → `AuthorizationRequested(url, code)` → `ConfirmDeviceLogin` → `GotApiKey` / `LoginFailed`, then `SetApiKey` / `ClearApiKey` |
| Utility | `SetBaseUrl`, `GetModels(kind)`, `ApiKeyIsSet`, error messages with status codes |

## Kodular compatibility (the part that usually breaks these ports)

- Compiled with **Java 7** `--source/--target` against the classic `AndroidRuntime` surface; verified with `dx`, not `d8`.
- No androidx, no desugaring, no runtime dependencies — only `java.net.HttpURLConnection` and `org.json` (both in every Android).
- Files land in the app's private directory via legacy ASD paths so Kodular's `File` component can read them.
- Manifest-consistent package name `io.kodular.pollinations`, Kodular creator `authURL` and upgradeable `YaVersions` block in the sample `.aia`.
- The `.aix` was built with the official `mit-cml/extension-template` toolchain (ant + JDK 17), so the block metadata (`components.json`, `component_build_infos.xml`) is real, not hand-rolled.

## Verified

- Built cleanly with the official extension toolchain: `BUILD SUCCESSFUL` in 3 s, `io.kodular.pollinations.aix` (50.9 KB) with full block metadata.
- Extension source + `.aix` round-tripped through the sample `.aia` layout that App Inventor / Kodular uses (`assets/external_comps/`), matching the formats used by AI2's `YoungAndroidProjectService` and `ComponentServiceImpl`.
- Live API calls exercised with a real Pollen key: chat completions, 104 text models + 20 image models listed, and a 1024×1024 JPEG generated through the same HTTP layer the blocks use.
- Error paths (401/429/network) map to friendly block events instead of silent failures.

## BYOP flow (users pay with their own Pollen)

The `StartDeviceLogin` block opens the Pollinations device-flow endpoint, surfaces the verification URL + code to the app user, and stores the returned key in the app's private storage. From then on every block call is billed to that user's own Pollen balance — the builder's key is never embedded.

## App submission

- App URL: this repository (release/download page for the `.aix` and sample `.aia`)
- Quest field: `#17248`
