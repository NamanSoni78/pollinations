"""
Unit tests for Pollinations GIMP 3 Plugin.
Tests BYOP Device flow, config persistence, model discovery, image generation request creation, and error recovery.
"""

import os
import json
import unittest
from unittest.mock import patch, MagicMock
import urllib.error

import sys
PLUGIN_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PLUGIN_DIR not in sys.path:
    sys.path.insert(0, PLUGIN_DIR)

from pollinations_config import load_config, save_config, clear_config, CONFIG_FILE
from pollinations_core import (
    PollinationsClient,
    PollinationsError,
    AuthenticationError,
    InsufficientPollenError,
)


class TestPollinationsConfig(unittest.TestCase):
    def setUp(self):
        clear_config()

    def tearDown(self):
        clear_config()

    def test_save_and_load_config(self):
        data = {"access_token": "sk_test123", "user_info": {"preferred_username": "tester"}}
        save_config(data)
        loaded = load_config()
        self.assertEqual(loaded.get("access_token"), "sk_test123")
        self.assertEqual(loaded.get("user_info", {}).get("preferred_username"), "tester")

    def test_clear_config(self):
        save_config({"access_token": "sk_test123"})
        clear_config()
        self.assertEqual(load_config(), {})


class TestPollinationsClient(unittest.TestCase):
    def setUp(self):
        clear_config()
        self.client = PollinationsClient()

    def tearDown(self):
        clear_config()

    def test_connection_status(self):
        self.assertFalse(self.client.is_connected())
        self.assertIsNone(self.client.get_token())

        self.client.token_data = {"access_token": "sk_mock_token"}
        self.assertTrue(self.client.is_connected())
        self.assertEqual(self.client.get_token(), "sk_mock_token")

        self.client.disconnect()
        self.assertFalse(self.client.is_connected())

    @patch("urllib.request.urlopen")
    def test_start_device_flow(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "device_code": "dev_123",
            "user_code": "ABCD-1234",
            "verification_uri": "/device",
            "expires_in": 900
        }).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.client.start_device_flow()
        self.assertEqual(res["device_code"], "dev_123")
        self.assertEqual(res["user_code"], "ABCD-1234")
        self.assertEqual(res["verification_url_full"], "https://enter.pollinations.ai/device?user_code=ABCD-1234")

    @patch("urllib.request.urlopen")
    def test_poll_device_token_pending(self, mock_urlopen):
        err = urllib.error.HTTPError(
            url="https://enter.pollinations.ai/api/device/token",
            code=400,
            msg="Bad Request",
            hdrs={},
            fp=MagicMock(read=lambda: b'{"error":"authorization_pending"}')
        )
        mock_urlopen.side_effect = err

        res = self.client.poll_device_token("dev_123")
        self.assertEqual(res, {"status": "pending"})

    @patch("urllib.request.urlopen")
    def test_poll_device_token_success(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "access_token": "sk_user_approved_token",
            "token_type": "bearer"
        }).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.client.poll_device_token("dev_123")
        self.assertEqual(res["access_token"], "sk_user_approved_token")
        self.assertTrue(self.client.is_connected())

    @patch("urllib.request.urlopen")
    def test_fetch_models(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps([
            {
                "name": "flux",
                "title": "FLUX.1 Schnell",
                "description": "Fast text to image",
                "input_modalities": ["text"],
                "community": False
            },
            {
                "name": "qwen-image-3.0-pro",
                "title": "Qwen Image 3 Pro",
                "description": "Image-to-image editing",
                "input_modalities": ["text", "image"],
                "community": True
            }
        ]).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        models = self.client.fetch_models()
        self.assertEqual(len(models), 2)
        self.assertEqual(models[0]["id"], "flux")
        self.assertFalse(models[0]["supports_image_input"])
        self.assertEqual(models[1]["id"], "qwen-image-3.0-pro")
        self.assertTrue(models[1]["supports_image_input"])
        self.assertTrue(models[1]["community"])

    @patch("urllib.request.urlopen")
    def test_generate_image_no_token(self, mock_urlopen):
        with self.assertRaises(AuthenticationError) as ctx:
            self.client.generate_image("A futuristic city")
        self.assertIn("No Pollinations account connected", str(ctx.exception))

    @patch("urllib.request.urlopen")
    def test_generate_image_success(self, mock_urlopen):
        self.client.token_data = {"access_token": "sk_valid_token"}
        mock_response = MagicMock()
        mock_response.headers = {"Content-Type": "image/png"}
        mock_response.status = 200
        mock_response.read.return_value = b"\x89PNG\r\n\x1a\n\x00\x00FakeImageData"
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res_bytes = self.client.generate_image("A cat sitting on a rug", model="flux")
        self.assertEqual(res_bytes, b"\x89PNG\r\n\x1a\n\x00\x00FakeImageData")

    @patch("urllib.request.urlopen")
    def test_generate_image_insufficient_pollen_error(self, mock_urlopen):
        self.client.token_data = {"access_token": "sk_valid_token"}
        err = urllib.error.HTTPError(
            url="https://gen.pollinations.ai/image/generate",
            code=402,
            msg="Payment Required",
            hdrs={},
            fp=MagicMock(read=lambda: b'{"error":"Insufficient pollen balance"}')
        )
        mock_urlopen.side_effect = err

        with self.assertRaises(InsufficientPollenError) as ctx:
            self.client.generate_image("A surreal painting")
        self.assertIn("Insufficient Pollen", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
