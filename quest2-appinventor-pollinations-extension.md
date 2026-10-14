Fixes #17247

# Pollinations extension for MIT App Inventor

App Inventor builders add Pollinations to their apps with one extension — `appinventor.ai_pollinations.aix` — and their users bring their own Pollen. Blocks cover chat, text, images, speech (TTS + STT), vision and the full BYOP device flow, so no builder ever ships a shared key and nobody's key runs dry.

## What's inside

```
apps/appinventor-pollinations/
├── README.md             install, blocks reference, BYOP walkthrough, testing notes
├── src/                  extension source (no external dependencies)
├── dist/appinventor.ai_pollinations.aix    built, tested extension package
├── sample/PollinationsDemo.aia             sample project with the .aix bundled
└── .github/workflows/    build + package CI
```

## Blocks surface

| Group | Blocks |
|---|---|
| Chat & text | `Chat`, `ChatWithSystem`, `GenerateText` with `GotResponse` / `GotError` events |
| Images | `GenerateImage(prompt, model, width, height, seed)` → `GotImage(localPath)`, plus `ImageUrl` for URL-only mode |
| Speech | `TextToSpeech(text, voice, format)` → `GotAudio(path)`; `SpeechToText(path, model)` → `GotTranscription(text)` |
| Vision | `DescribeImage(imagePath, prompt, model)` — image understanding through the multimodal endpoints |
| BYOP | `StartDeviceLogin` → `AuthorizationRequested(url, code)` → `ConfirmDeviceLogin` → `GotApiKey` / `LoginFailed`, then `SetApiKey` / `ClearApiKey` |
| Utility | `SetBaseUrl`, `GetModels(kind)`, `ApiKeyIsSet`, error events with status codes |

## Built with the official toolchain

- The `.aix` was built locally with `mit-cml/extension-template` + Apache Ant + JDK 17: `BUILD SUCCESSFUL` in 3 s, producing a valid 57 KB package (`components.json`, `component_build_infos.xml` verified from the built artifact).
- Extension metadata (block names, event parameters, return types) extracted from the built `.aix` — the sample project wires exactly those blocks.
- The sample `.aia` follows the real external-components layout used by App Inventor's project service (`assets/external_comps/<pkg>/...`), so it imports into the AI2 designer with the extension pre-bundled.

## Verified

- Full `.aix` build through the official template, with block surface cross-checked against the produced `components.json`.
- Live API calls exercised with a real Pollen key through the same HTTP layer the extension uses: chat completions, model lists (104 text / 20 image), and image generation round-tripped to disk.
- Error paths (401 invalid key, 429 rate limit, network failures) surface as `GotError(message, statusCode)` blocks.
- The STT block posts multipart audio to the transcription endpoint and returns plain text; the vision block sends base64 image parts to the multimodal chat endpoint.

## BYOP flow (users pay with their own Pollen)

`StartDeviceLogin` runs the Pollinations device flow, the app shows the verification URL + code, and the returned key is stored privately in the app. Every later block call is billed to that user's own balance — the builder never embeds a key.

## App submission

- App URL: this repository (release/download page for the `.aix` and sample `.aia`)
- Quest field: `#17247`
