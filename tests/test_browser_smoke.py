import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.request import urlopen

from observer.server import Handler


class BrowserSmokeTests(unittest.TestCase):
    def test_dashboard_shell_and_modules_load_against_fixture_server(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            with urlopen(base) as response:
                html = response.read().decode()
            self.assertIn('type="module"', html)
            for module in ("api.js", "app.js", "chart.js", "history.js", "render.js", "time.js"):
                with urlopen(f"{base}/js/{module}") as response:
                    self.assertEqual(response.status, 200)
            with urlopen(f"{base}/api/v1/status") as response:
                self.assertTrue(json.load(response)["ok"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
