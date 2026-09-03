"""
Configuration and constants for Pollinations GIMP 3 Plugin.
"""

import os
import json
import pathlib

APP_KEY = "pk_gimp_plugin_byop" # Publishable App Key / client_id for attribution
AUTH_SERVER = "https://enter.pollinations.ai"
GEN_SERVER = "https://gen.pollinations.ai"

DEVICE_CODE_URL = f"{AUTH_SERVER}/api/device/code"
DEVICE_TOKEN_URL = f"{AUTH_SERVER}/api/device/token"
USERINFO_URL = f"{AUTH_SERVER}/api/device/userinfo"
MODELS_URL = f"{GEN_SERVER}/image/models"
GENERATE_URL = f"{GEN_SERVER}/image/generate"

CONFIG_DIR = os.path.join(pathlib.Path.home(), ".config", "pollinations_gimp")
CONFIG_FILE = os.path.join(CONFIG_DIR, "auth.json")

def load_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_config(data):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def clear_config():
    if os.path.exists(CONFIG_FILE):
        try:
            os.remove(CONFIG_FILE)
        except Exception:
            pass
