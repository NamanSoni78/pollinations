import unittest
from unittest.mock import patch, MagicMock
import json
import os
import tempfile
import sys

# Add directory to sys.path
sys.path.insert(0, os.path.dirname(__file__))

from pollinations_auth import AuthManager
from pollinations_api import PollinationsAPI, PollinationsAPIError

class TestPollinationsAuth(unittest.TestCase):

    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.auth_file = os.path.join(self.temp_dir, "auth.json")
        self.auth_manager = AuthManager(config_path=self.auth_file)

    def tearDown(self):
        if os.path.exists(self.auth_file):
            os.remove(self.auth_file)
        os.rmdir(self.temp_dir)

    def test_save_and_load_auth(self):
        self.assertIsNone(self.auth_manager.get_token())
        test_data = {"access_token": "sk_test_12345", "token_type": "bearer"}
        self.auth_manager.save_auth(test_data)

        self.assertEqual(self.auth_manager.get_token(), "sk_test_12345")
        self.assertEqual(self.auth_manager.load_auth(), test_data)

    def test_clear_auth(self):
        self.auth_manager.save_auth({"access_token": "sk_test_12345"})
        self.assertEqual(self.auth_manager.get_token(), "sk_test_12345")
        self.auth_manager.clear_auth()
        self.assertIsNone(self.auth_manager.get_token())


class TestPollinationsAPI(unittest.TestCase):

    def setUp(self):
        self.api = PollinationsAPI(token="sk_test_token")

    @patch("urllib.request.urlopen")
    def test_start_device_flow(self, mock_urlopen):
        mock_response = MagicMock()
        mock_response.read.return_value = json.dumps({
            "device_code": "dev123",
            "user_code": "ABCD-1234",
            "verification_uri": "https://enter.pollinations.ai/device",
            "verification_uri_complete": "https://enter.pollinations.ai/device?user_code=ABCD-1234",
            "expires_in": 1800,
            "interval": 5
        }).encode("utf-8")
        mock_response.__enter__.return_value = mock_response
        mock_urlopen.return_value = mock_response

        res = self.api.start_device_flow()
        self.assertEqual(res["user_code"], "ABCD-1234")
        self.assertEqual(res["device_code"], "dev123")

    @patch("urllib.request.urlopen")
    def test_parse_model_capabilities(self, mock_urlopen):
        raw_models = [
            {
                "name": "flux",
                "title": "FLUX Image Generator",
                "category": "image",
                "input_modalities": ["text"],
                "output_modalities": ["image"],
                "community": False
            },
            {
                "name": "kontext",
                "title": "Kontext Inpainting",
                "category": "image",
                "input_modalities": ["text", "image"],
                "output_modalities": ["image"],
                "community": False
            },
            {
                "name": "text-only-model",
                "category": "text",
                "input_modalities": ["text"],
                "output_modalities": ["text"]
            }
        ]

        parsed = self.api.parse_model_capabilities(raw_models)
        self.assertEqual(len(parsed), 2)

        flux_model = next(m for m in parsed if m["id"] == "flux")
        self.assertFalse(flux_model["supports_image_input"])

        kontext_model = next(m for m in parsed if m["id"] == "kontext")
        self.assertTrue(kontext_model["supports_image_input"])


if __name__ == "__main__":
    unittest.main()

class TestDynamicModelCatalog(unittest.TestCase):

    def setUp(self):
        self.api = PollinationsAPI()

    @patch("urllib.request.urlopen")
    def test_fetch_image_models_filtering_and_community(self, mock_urlopen):
        mock_data = [
            {
                "name": "community/user/custom-flux",
                "title": "Community Flux Model",
                "category": "image",
                "community": True,
                "input_modalities": ["text"],
                "output_modalities": ["image"]
            },
            {
                "name": "official-chat",
                "title": "Text Chat Model",
                "category": "text",
                "community": False,
                "input_modalities": ["text"],
                "output_modalities": ["text"]
            }
        ]
        mock_resp = MagicMock()
        mock_resp.read.return_value = json.dumps(mock_data).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        models = self.api.fetch_image_models()
        self.assertEqual(len(models), 1)
        self.assertEqual(models[0]["id"], "community/user/custom-flux")
        self.assertTrue(models[0]["community"])

class TestImageGenerationAndEditing(unittest.TestCase):

    def setUp(self):
        self.api = PollinationsAPI(token="sk_test_token")

    @patch("urllib.request.urlopen")
    def test_generate_image_success(self, mock_urlopen):
        import base64
        fake_image_bytes = b"fake_png_data"
        b64_img = base64.b64encode(fake_image_bytes).decode("utf-8")

        mock_resp = MagicMock()
        mock_resp.headers.get.return_value = "application/json"
        mock_resp.read.return_value = json.dumps({
            "created": 123456,
            "data": [{"b64_json": b64_img}]
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        result = self.api.generate_image("a cute cat", model="zimage", width=1024, height=1024)
        self.assertEqual(result, fake_image_bytes)

    @patch("urllib.request.urlopen")
    def test_edit_image_error_handling(self, mock_urlopen):
        import urllib.error
        mock_error = urllib.error.HTTPError(
            url="https://gen.pollinations.ai/v1/images/edits",
            code=402,
            msg="Payment Required",
            hdrs={},
            fp=MagicMock(read=lambda: json.dumps({"error": {"message": "Insufficient pollen balance"}}).encode("utf-8"))
        )
        mock_urlopen.side_effect = mock_error

        with self.assertRaises(PollinationsAPIError) as cm:
            self.api.edit_image("make it sunset", b"source_image_bytes")

        self.assertEqual(cm.exception.status_code, 402)
        self.assertIn("Insufficient Pollen balance", cm.exception.message)
