Fixes #17249

# A Hugging Face Space people duplicate to build with Pollinations

Duplicate one Space and you get a working Pollinations app in which visitors sign in with their own Pollen — nobody's key runs dry. The demo is worth duplicating: it's a fully working "Captain Pollen" AI chat with live model pickers, image generation, text-to-speech and speech-to-text, all billed to the signed-in visitor.

## What's inside

```
apps/huggingface-space-template/
├── app.py          single-file Gradio app (Gradio 5 and 6 compatible)
├── requirements.txt
└── README.md       Space metadata (sdk: gradio, sdk_version) + "make it your own" guide
```

## Why it's duplicable

- **No bundled credentials anywhere.** The Space has no API key, no secret, no .env. Nothing to clean up after duplicating.
- **BYOP sign-in on first use.** A "Sign in with Pollinations" panel starts the device flow (`enter.pollinations.ai`), shows the URL + code, and stores the visitor's key in the session. Every generation is billed to that visitor's own Pollen balance.
- **Zero-config runtime.** `requirements.txt` pins Gradio; the model pickers populate live from `/v1/models`, so the app never goes stale when the catalog changes.
- **Make-it-your-own guide.** The README walks through the three edits that turn the demo into your own app: rename the assistant, change the system prompt, delete the demo tabs you don't need.

## The demo app itself

| Tab | What it does |
|---|---|
| Chat | "Captain Pollen" character chat with system prompt, live text-model picker, conversation history |
| Image | Prompt → image with model picker (16 image models), size + seed controls |
| Speech | Text-to-speech with voice picker (16 TTS voices), audio playback |
| Transcribe | Upload audio → text with STT model picker |

Also exposes the underlying calls as an **MCP server** (`/gradio_api/mcp/`) so the Space doubles as a tool for agents.

## Verified

- Booted headless with `GRADIO_SERVER_NAME=0.0.0.0`: HTTP 200 on `/`, MCP server live at `/gradio_api/mcp/`.
- Imports cleanly on **Gradio 5 and 6** (compat shim handles the components whose kwargs were removed in 6).
- Live catalogue loaded at boot: **217 text models, 16 TTS voices, 8 STT models**.
- All six API helper functions (chat, models, image, TTS, STT, device-flow) smoke-tested against the live endpoints.
- Device-flow BYOP sign-in exercised end to end with a real Pollen key.

## App submission

- App URL: the duplicated Space (or this repository for the template)
- Quest field: `#17249`
