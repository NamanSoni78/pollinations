# Pollinations AI GIMP 3 Plug-in

Integrate **Pollinations AI** image generation and image-to-image editing directly inside **GIMP 3** across Linux, macOS, and Windows.

Each user connects their own Pollinations account via **Bring Your Own Pollen (BYOP)** device authorization — no API keys need to be pasted into GIMP.

---

## Features

- **BYOP Device Flow Authentication:** Secure browser-based authorization (`enter.pollinations.ai/device`).
- **Persistent Account Session:** Authorization persists across GIMP restarts in local configuration (`~/.config/pollinations_gimp/auth.json`).
- **Dynamic Model Catalog:** Loads live model catalog runtime from `/image/models`, giving immediate access to all official and community models without hardcoded model lists.
- **Capability-Driven UI:** UI controls dynamically adapt based on model capabilities (`input_modalities`), enabling/disabling image input support automatically.
- **Flexible Generation Modes:**
  - **Create New Image:** Generates a new GIMP image window.
  - **Add as New Layer:** Appends the generated result as a new layer in the active image without altering existing source layers.
  - **Edit Active Layer / Selection (Image-to-Image):** Sends current active layer/selection to supported models for AI editing and returns the result as a new layer.
- **Clear Error & Recovery Messages:** Contextual guidance for expired sessions, insufficient Pollen balance, network failures, and API errors.

---

## Installation Instructions

### Prerequisites
- **GIMP 3.0+** installed on your system.
- **Python 3** with `PyGObject` (included standard with GIMP 3 Python support).

---

### Linux Installation

1. Copy the plugin directory into your GIMP 3 plug-ins directory:
   ```bash
   mkdir -p ~/.config/GIMP/3.0/plug-ins/pollinations_gimp
   cp -r apps/gimp-plugin/* ~/.config/GIMP/3.0/plug-ins/pollinations_gimp/
   ```
2. Ensure the main plug-in script is executable:
   ```bash
   chmod +x ~/.config/GIMP/3.0/plug-ins/pollinations_gimp/pollinations_gimp.py
   ```

---

### macOS Installation

1. Navigate to your user GIMP 3 plug-ins folder:
   ```bash
   mkdir -p ~/Library/Application\ Support/GIMP/3.0/plug-ins/pollinations_gimp
   cp -r apps/gimp-plugin/* ~/Library/Application\ Support/GIMP/3.0/plug-ins/pollinations_gimp/
   chmod +x ~/Library/Application\ Support/GIMP/3.0/plug-ins/pollinations_gimp/pollinations_gimp.py
   ```

---

### Windows Installation

1. Open File Explorer and navigate to:
   `%APPDATA%\GIMP\3.0\plug-ins\`
2. Create a folder named `pollinations_gimp`.
3. Copy all files from `apps/gimp-plugin/` into `%APPDATA%\GIMP\3.0\plug-ins\pollinations_gimp\`.

---

## Usage Guide

1. **Launch GIMP 3**.
2. Open the menu item: **Filters** -> **Render** -> **Pollinations AI Generator & Editor...**
3. **Connect Account:**
   - Click **Connect Pollinations Account**.
   - Your web browser will open to `https://enter.pollinations.ai/device`.
   - Confirm access in your browser using the displayed user code.
4. **Select Model & Prompt:**
   - Select your preferred image model from the dropdown.
   - Enter your prompt and optional parameters (width, height, seed).
5. **Generate & Edit:**
   - Choose output mode (**Create New Image**, **Add as New Layer**, or **Edit Active Layer/Selection**).
   - Click **Generate**.

---

## Testing & CLI Demonstration

Run unit tests:
```bash
python3 -m unittest discover -s apps/gimp-plugin/tests
```

Run CLI end-to-end demonstration harness:
```bash
python3 apps/gimp-plugin/demo.py
```
