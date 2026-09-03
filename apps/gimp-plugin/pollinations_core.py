"""
Core API client for Pollinations GIMP 3 Plugin.
Handles BYOP Device flow authentication, model catalog fetching, image generation, image editing, and error formatting.
"""

import os
import json
import time
import base64
import urllib.request
import urllib.parse
import urllib.error
from pollinations_config import (
    APP_KEY,
    DEVICE_CODE_URL,
    DEVICE_TOKEN_URL,
    USERINFO_URL,
    MODELS_URL,
    GENERATE_URL,
    load_config,
    save_config,
    clear_config,
)

class PollinationsError(Exception):
    """Base exception for Pollinations errors with user friendly recovery guidance."""
    def __init__(self, message, recovery=None, status_code=None):
        super().__init__(message)
        self.message = message
        self.recovery = recovery or "Please check your network connection and try again."
        self.status_code = status_code

    def __str__(self):
        if self.recovery:
            return f"{self.message}\n\nRecovery: {self.recovery}"
        return self.message

class AuthenticationError(PollinationsError):
    """Authorization or token error."""
    pass

class InsufficientPollenError(PollinationsError):
    """Pollen balance exceeded or insufficient funds."""
    pass

class PollinationsClient:
    def __init__(self):
        self.token_data = load_config()

    def is_connected(self):
        return bool(self.token_data and self.token_data.get("access_token"))

    def get_token(self):
        return self.token_data.get("access_token") if self.token_data else None

    def get_saved_user(self):
        return self.token_data.get("user_info", {}) if self.token_data else {}

    def disconnect(self):
        self.token_data = {}
        clear_config()

    def start_device_flow(self):
        """
        Requests a device authorization code from enter.pollinations.ai
        Returns dict containing device_code, user_code, verification_uri, interval, expires_in
        """
        payload = json.dumps({"client_id": APP_KEY}).encode("utf-8")
        req = urllib.request.Request(
            DEVICE_CODE_URL,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "Pollinations-GIMP3-Plugin"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                # Verification URL can be relative or full
                if data.get("verification_uri", "").startswith("/"):
                    data["verification_url_full"] = f"https://enter.pollinations.ai{data['verification_uri']}?user_code={data.get('user_code', '')}"
                else:
                    data["verification_url_full"] = data.get("verification_uri", "https://enter.pollinations.ai/device")
                return data
        except urllib.error.URLError as e:
            raise PollinationsError(f"Failed to start device authorization: {e}", "Check your internet connection.")

    def poll_device_token(self, device_code):
        """
        Polls enter.pollinations.ai/api/device/token for access token.
        Returns access_token dict or raises error / authorization_pending status.
        """
        payload = json.dumps({"device_code": device_code}).encode("utf-8")
        req = urllib.request.Request(
            DEVICE_TOKEN_URL,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "Pollinations-GIMP3-Plugin"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                if "access_token" in res:
                    # Successfully obtained token!
                    user_info = {}
                    try:
                        user_info = self.fetch_user_info(res["access_token"])
                    except Exception:
                        pass
                    res["user_info"] = user_info
                    self.token_data = res
                    save_config(self.token_data)
                return res
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                err_type = err_json.get("error", "")
                if err_type == "authorization_pending":
                    return {"status": "pending"}
                elif err_type == "slow_down":
                    return {"status": "slow_down"}
                elif err_type == "expired_token":
                    raise AuthenticationError("Authorization code expired.", "Please click Connect again to start a new authorization process.")
                elif err_type == "access_denied":
                    raise AuthenticationError("Authorization was denied by user.", "Click Connect again if you wish to authorize.")
            except json.JSONDecodeError:
                pass
            raise PollinationsError(f"Device token polling failed ({e.code}): {err_body}", "Try re-authenticating.")
        except urllib.error.URLError as e:
            raise PollinationsError(f"Network error while polling auth token: {e}", "Check internet connection.")

    def fetch_user_info(self, token=None):
        """
        Fetches user profile info using user-authorized token.
        """
        tok = token or self.get_token()
        if not tok:
            return {}
        req = urllib.request.Request(
            USERINFO_URL,
            headers={"Authorization": f"Bearer {tok}", "User-Agent": "Pollinations-GIMP3-Plugin"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return {}

    def fetch_models(self):
        """
        Fetches available image models from /image/models.
        Exposes model details including name, title, description, input_modalities, community, pricing.
        """
        req = urllib.request.Request(
            MODELS_URL,
            headers={"User-Agent": "Pollinations-GIMP3-Plugin"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                models_raw = json.loads(resp.read().decode("utf-8"))
                models = []
                for m in models_raw:
                    m_id = m.get("name")
                    if not m_id:
                        continue
                    input_mods = m.get("input_modalities", ["text"])
                    models.append({
                        "id": m_id,
                        "title": m.get("title") or m_id,
                        "description": m.get("description", ""),
                        "input_modalities": input_mods,
                        "supports_image_input": "image" in input_mods,
                        "community": m.get("community", False),
                        "pricing": m.get("pricing", {}),
                        "paid_only": m.get("paid_only", False),
                    })
                return models
        except urllib.error.URLError as e:
            raise PollinationsError(f"Failed to fetch model catalog: {e}", "Ensure your network connection is active.")

    def generate_image(self, prompt, model="flux", width=1024, height=1024, seed=None, input_image_bytes=None, negative_prompt=None):
        """
        Generates or edits an image using Pollinations image API.
        If input_image_bytes is provided and model supports image input, it will be sent as a base64 data URI or multipart body.
        Returns raw image bytes (PNG/JPEG) from Pollinations.
        """
        token = self.get_token()
        if not token:
            raise AuthenticationError("No Pollinations account connected.", "Please connect your account via the BYOP Device authorization step.")

        headers = {
            "Authorization": f"Bearer {token}",
            "User-Agent": "Pollinations-GIMP3-Plugin"
        }

        # Build request parameters according to Pollinations Image API specs
        req_payload = {
            "prompt": prompt,
            "model": model,
            "width": width,
            "height": height,
        }
        if seed is not None:
            req_payload["seed"] = seed
        if negative_prompt:
            req_payload["negative_prompt"] = negative_prompt

        if input_image_bytes:
            # Format input image as Base64 Data URI or multipart depending on API support
            b64_img = base64.b64encode(input_image_bytes).decode("utf-8")
            req_payload["image"] = f"data:image/png;base64,{b64_img}"

        data_json = json.dumps(req_payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

        req = urllib.request.Request(
            GENERATE_URL,
            data=data_json,
            headers=headers,
            method="POST"
        )

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                content_type = resp.headers.get("Content-Type", "")
                if "image" in content_type or resp.status == 200:
                    return resp.read()
                else:
                    body = resp.read().decode("utf-8", errors="ignore")
                    raise PollinationsError(f"Unexpected response content type '{content_type}': {body}")
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            if e.code == 401:
                raise AuthenticationError("Authorization expired or invalid.", "Please click Disconnect and then Connect to re-authenticate your Pollinations account.", status_code=401)
            elif e.code in (402, 403) or "pollen" in body.lower() or "balance" in body.lower():
                raise InsufficientPollenError("Insufficient Pollen or payment required.", "Your Pollinations account balance is low. Please add Pollen at enter.pollinations.ai.", status_code=e.code)
            else:
                try:
                    err_data = json.loads(body)
                    msg = err_data.get("error") or err_data.get("message") or body
                except json.JSONDecodeError:
                    msg = body
                raise PollinationsError(f"API Error ({e.code}): {msg}", "Check your prompt or model options and try again.", status_code=e.code)
        except urllib.error.URLError as e:
            raise PollinationsError(f"Network error during image generation: {e}", "Please check your internet connection.")
