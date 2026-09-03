import json
import os
from typing import Optional, Dict, Any

DEFAULT_CONFIG_DIR = os.path.expanduser("~/.config/pollinations-gimp")
DEFAULT_AUTH_FILE = os.path.join(DEFAULT_CONFIG_DIR, "auth.json")

class AuthManager:
    """Manages persistent storage and retrieval of Pollinations API auth tokens."""

    def __init__(self, config_path: str = DEFAULT_AUTH_FILE):
        self.config_path = config_path

    def load_auth(self) -> Dict[str, Any]:
        """Loads auth credentials from disk if present."""
        if not os.path.exists(self.config_path):
            return {}
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}

    def get_token(self) -> Optional[str]:
        """Returns the stored user access token (sk_...) or None."""
        data = self.load_auth()
        return data.get("access_token")

    def save_auth(self, auth_data: Dict[str, Any]) -> None:
        """Saves auth credentials to disk."""
        os.makedirs(os.path.dirname(self.config_path), exist_ok=True)
        with open(self.config_path, "w", encoding="utf-8") as f:
            json.dump(auth_data, f, indent=2)

    def clear_auth(self) -> None:
        """Deletes saved auth credentials (disconnect)."""
        if os.path.exists(self.config_path):
            try:
                os.remove(self.config_path)
            except Exception:
                pass
