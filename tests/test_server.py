import json
import threading
import unittest
import os
from http.server import ThreadingHTTPServer
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from observer.config import ConfigurationError, ServerConfig

from observer.server import Handler


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_v1_discovery_document(self):
        with urlopen(f"{self.base}/api/v1") as response:
            payload = json.load(response)
        self.assertEqual(payload["version"], "v1")
        self.assertIn("/api/v1/instances/{name}/history?limit=900", payload["endpoints"])

    def test_static_javascript_module_is_served(self):
        with urlopen(f"{self.base}/js/app.js") as response:
            body = response.read().decode()
        self.assertIn("from './api.js'", body)

    def test_status_contract_and_build_metadata_are_published(self):
        with urlopen(f"{self.base}/api/v1/status") as response:
            payload = json.load(response)
        self.assertIn("build", payload)
        self.assertIn("collection", payload)
        with urlopen(f"{self.base}/api/v1/schema") as response:
            schema = json.load(response)
        self.assertIn("status", schema["contracts"])

    def test_basic_auth_protects_dashboard_but_not_health(self):
        with patch.dict(os.environ, {"VLLM_OBSERVER_AUTH_USERNAME": "observer", "VLLM_OBSERVER_AUTH_PASSWORD": "secret"}):
            with self.assertRaises(HTTPError) as denied:
                urlopen(f"{self.base}/api/v1/status")
            self.assertEqual(denied.exception.code, 401)
            request = Request(f"{self.base}/api/v1/status", headers={"Authorization": "Basic b2JzZXJ2ZXI6c2VjcmV0"})
            with urlopen(request) as response:
                self.assertTrue(json.load(response)["ok"])
            with urlopen(f"{self.base}/api/health") as response:
                self.assertTrue(json.load(response)["ok"])

    def test_cors_is_same_origin_by_default_and_allowlisted_when_configured(self):
        request = Request(f"{self.base}/api/v1", headers={"Origin": "https://example.test"})
        with urlopen(request) as response:
            self.assertIsNone(response.headers.get("Access-Control-Allow-Origin"))
        with patch.dict(os.environ, {"VLLM_OBSERVER_CORS_ORIGINS": "https://example.test"}):
            with urlopen(request) as response:
                self.assertEqual(response.headers.get("Access-Control-Allow-Origin"), "https://example.test")

    def test_invalid_configuration_is_actionable(self):
        with patch.dict(os.environ, {"VLLM_OBSERVER_PORT": "nope"}):
            with self.assertRaisesRegex(ConfigurationError, "VLLM_OBSERVER_PORT"):
                ServerConfig.from_env()


if __name__ == "__main__":
    unittest.main()
