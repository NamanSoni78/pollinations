# Pollinations AI GIMP 3 Plug-in

Bring Pollinations AI image generation and editing directly inside GIMP 3! Users can log in with their own Pollinations account via Bring Your Own Pollen (BYOP) Device Authorization without pasting API keys into GIMP.

## Features

- **BYOP Device Authorization Flow**: Securely connect and disconnect your Pollinations account (`sk_...`). The plug-in opens your browser automatically; you never paste API keys into GIMP. Account authorization persists across GIMP restarts.
- **Dynamic Model Catalog**: Loads image models dynamically from `https://gen.pollinations.ai/image/models` at runtime. Exposes all available image models including community models.
- **Model Capabilities**: Automatically detects model input modalities (`text` vs `text+image`) to drive interface controls and functionality.
- **Text-to-Image Generation**: Generate high-quality images from text prompts and add results as a new layer or new image in GIMP.
- **Image Editing / Image-to-Image**: Pass active GIMP layers or selections to supported editing models (e.g., `kontext`, `p-image-edit`) and return the edited result as a new layer without altering the source image.
- **Clear Error Recovery**: User-friendly feedback for insufficient pollen, expired authorization, network issues, and API errors.

---

## Installation Instructions

### Prerequisites
- **GIMP 3.0 or higher** with Python 3 plug-in support enabled.

### 1. Locate your GIMP 3 Plug-ins Folder

Find your platform's plug-in directory:

- **Linux**: `~/.config/GIMP/3.0/plug-ins/`
- **macOS**: `~/Library/Application Support/GIMP/3.0/plug-ins/`
- **Windows**: `%APPDATA%\GIMP\3.0\plug-ins\`

### 2. Install the Plug-in

Create a folder named `pollinations_plugin` inside your GIMP 3 `plug-ins` directory, and copy all files from `apps/gimp-pollinations/` into it:

```bash
# Example for Linux
mkdir -p ~/.config/GIMP/3.0/plug-ins/pollinations_plugin
cp -r apps/gimp-pollinations/* ~/.config/GIMP/3.0/plug-ins/pollinations_plugin/
chmod +x ~/.config/GIMP/3.0/plug-ins/pollinations_plugin/pollinations_plugin.py
```

### 3. Usage inside GIMP 3

1. Launch GIMP 3.
2. Open the menu: **Filters → Render → Pollinations AI...**
3. Click **Connect Account** to sign in with your Pollinations account via browser device code authorization.
4. Select your preferred image model from the dropdown list.
5. Enter your prompt and click **Generate**.
