import json
import urllib.request
import urllib.parse
import urllib.error
import time
import webbrowser
import uuid
import os
from typing import List, Dict, Any, Optional, Tuple

APP_KEY = "pk_gimp_pollinations"
ENTER_BASE_URL = "https://enter.pollinations.ai"
GEN_BASE_URL = "https://gen.pollinations.ai"

class PollinationsAPIError(Exception):
    def __init__(self, message: str, status_code: Optional[int] = None, error_code: Optional[str] = None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.error_code = error_code

class PollinationsAPI:
    """Client for Pollinations AI device auth, model catalog, and image generation/editing."""

    def __init__(self, token: Optional[str] = None, client_id: str = APP_KEY):
        self.token = token
        self.client_id = client_id

    # --- BYOP Device Authorization Flow ---

    def start_device_flow(self) -> Dict[str, Any]:
        """Requests a device code from enter.pollinations.ai."""
        url = f"{ENTER_BASE_URL}/api/device/code"
        payload = json.dumps({"client_id": self.client_id}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            raise PollinationsAPIError(f"Failed to initiate device auth: {body}", status_code=e.code)
        except Exception as e:
            raise PollinationsAPIError(f"Network error starting device auth: {str(e)}")

    def poll_device_token(self, device_code: str, interval: int = 5, expires_in: int = 1800) -> Dict[str, Any]:
        """Polls enter.pollinations.ai until the user approves device authorization."""
        url = f"{ENTER_BASE_URL}/api/device/token"
        payload = json.dumps({"device_code": device_code}).encode("utf-8")
        start_time = time.time()

        while time.time() - start_time < expires_in:
            req = urllib.request.Request(
                url,
                data=payload,
                headers={"Content-Type": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    if "access_token" in data:
                        self.token = data["access_token"]
                        return data
                    if data.get("error") not in ("authorization_pending", "slow_down"):
                        raise PollinationsAPIError(f"Authorization error: {data.get('error')}")
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", errors="ignore")
                try:
                    err_json = json.loads(body)
                    err_type = err_json.get("error") or err_json.get("message")
                except Exception:
                    err_type = body
                if err_type not in ("authorization_pending", "slow_down"):
                    raise PollinationsAPIError(f"Authorization failed: {err_type}", status_code=e.code)

            time.sleep(interval)

        raise PollinationsAPIError("Authorization timed out. Please try connecting again.")

    def get_user_info(self) -> Dict[str, Any]:
        """Fetches user info for the currently connected Pollinations account."""
        if not self.token:
            raise PollinationsAPIError("Not authenticated", status_code=401)
        url = f"{ENTER_BASE_URL}/api/device/userinfo"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {self.token}"}
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 401:
                raise PollinationsAPIError("Authorization expired or invalid. Please reconnect.", status_code=401)
            raise PollinationsAPIError(f"Failed to fetch user info: {e.reason}", status_code=e.code)
        except Exception as e:
            raise PollinationsAPIError(f"Network error fetching user info: {str(e)}")

    # --- Model Catalog & Capabilities ---

    def fetch_image_models(self) -> List[Dict[str, Any]]:
        """
        Loads the live image model catalog from gen.pollinations.ai/image/models.
        Exposes every image model available to the connected account, including community models.
        """
        url = f"{GEN_BASE_URL}/image/models"
        headers = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw_models = json.loads(resp.read().decode("utf-8"))
                return self.parse_model_capabilities(raw_models)
        except urllib.error.HTTPError as e:
            raise PollinationsAPIError(f"Failed to fetch models: HTTP {e.code}", status_code=e.code)
        except Exception as e:
            raise PollinationsAPIError(f"Network error fetching model catalog: {str(e)}")

    def parse_model_capabilities(self, models_list: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Parses model capabilities (input modalities, options) to drive GIMP UI controls."""
        parsed = []
        for m in models_list:
            # Filter for image output models
            output_mods = m.get("output_modalities", [])
            category = m.get("category")
            if "image" not in output_mods and category != "image":
                continue

            name = m.get("name")
            aliases = m.get("aliases", [])
            canonical_id = name or (aliases[0] if aliases else "zimage")

            title = m.get("title") or canonical_id
            description = m.get("description", "")
            community = m.get("community", False)
            input_mods = m.get("input_modalities", ["text"])
            supports_image_input = "image" in input_mods or "p-image-edit" in canonical_id

            pricing = m.get("pricing", {})
            pollen_cost = pricing.get("completionImageTokens") or pricing.get("completionImagePrice")

            parsed.append({
                "id": canonical_id,
                "title": title,
                "description": description,
                "community": community,
                "input_modalities": input_mods,
                "supports_image_input": supports_image_input,
                "pollen_cost": pollen_cost,
                "raw": m
            })
        return parsed

    # --- Image Generation & Editing ---

    def generate_image(
        self,
        prompt: str,
        model: str = "zimage",
        width: int = 1024,
        height: int = 1024,
        seed: Optional[int] = None,
        quality: Optional[str] = None,
        transparent: bool = False
    ) -> bytes:
        """Generates an image from a text prompt (Text-to-Image). Returns raw image bytes (PNG/JPEG)."""
        url = f"{GEN_BASE_URL}/v1/images/generations"
        payload = {
            "prompt": prompt,
            "model": model,
            "size": f"{width}x{height}",
            "response_format": "b64_json"
        }
        if quality:
            payload["quality"] = quality
        if transparent:
            payload["transparent"] = True

        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
        return self._execute_image_request(req)

    def edit_image(
        self,
        prompt: str,
        image_bytes: bytes,
        model: str = "kontext",
        width: int = 1024,
        height: int = 1024
    ) -> bytes:
        """Edits an image using a prompt and source image bytes (Image-to-Image / Inpainting)."""
        url = f"{GEN_BASE_URL}/v1/images/edits"
        boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
        body = []

        # Prompt field
        body.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n{prompt}\r\n".encode("utf-8"))
        # Model field
        body.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n".encode("utf-8"))
        # Size field
        body.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"size\"\r\n\r\n{width}x{height}\r\n".encode("utf-8"))
        # Image file field
        body.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"input.png\"\r\nContent-Type: image/png\r\n\r\n".encode("utf-8")
            + image_bytes
            + b"\r\n"
        )
        body.append(f"--{boundary}--\r\n".encode("utf-8"))

        payload = b"".join(body)
        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}"
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        req = urllib.request.Request(url, data=payload, headers=headers)
        return self._execute_image_request(req)

    def _execute_image_request(self, req: urllib.request.Request) -> bytes:
        import base64
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                content_type = resp.headers.get("Content-Type", "")
                data = resp.read()
                if "application/json" in content_type:
                    res_json = json.loads(data.decode("utf-8"))
                    if "data" in res_json and len(res_json["data"]) > 0:
                        item = res_json["data"][0]
                        if "b64_json" in item:
                            return base64.b64decode(item["b64_json"])
                        elif "url" in item:
                            img_req = urllib.request.Request(item["url"])
                            with urllib.request.urlopen(img_req, timeout=60) as img_resp:
                                return img_resp.read()
                return data
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="ignore")
            self._handle_api_error(e.code, body)
        except Exception as e:
            raise PollinationsAPIError(f"Network error executing image request: {str(e)}")

    def _handle_api_error(self, status_code: int, response_body: str):
        msg = f"API Error (HTTP {status_code})"
        try:
            err_json = json.loads(response_body)
            if "error" in err_json:
                e_data = err_json["error"]
                if isinstance(e_data, dict):
                    msg = e_data.get("message", msg)
                elif isinstance(e_data, str):
                    msg = e_data
            elif "message" in err_json:
                msg = err_json["message"]
        except Exception:
            pass

        if status_code == 401:
            raise PollinationsAPIError("Authorization expired or invalid. Please reconnect your account.", status_code=401)
        elif status_code == 402:
            raise PollinationsAPIError("Insufficient Pollen balance in your Pollinations account.", status_code=402)
        elif status_code == 429:
            raise PollinationsAPIError("Rate limit exceeded. Please wait a moment and try again.", status_code=429)
        else:
            raise PollinationsAPIError(msg, status_code=status_code)
