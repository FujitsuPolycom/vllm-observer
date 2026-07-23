import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import urlopen

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


if __name__ == "__main__":
    unittest.main()
