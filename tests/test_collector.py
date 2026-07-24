import unittest
import subprocess
from unittest.mock import patch

from observer.collector import Collector


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.collector = Collector()

    def test_metrics_url_uses_published_host_port(self):
        record = {
            "name": "model",
            "running": True,
            "env": {},
            "command": "/opt/venv/bin/vllm serve /model --port=5802",
            "network_mode": "build_default",
            "ports": {"5802/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5810"}]},
        }
        self.assertEqual(
            self.collector.metrics_url_for("model", record),
            "http://127.0.0.1:5810/metrics",
        )

    def test_expected_model_reads_served_model_command_flag(self):
        record = {
            "name": "model",
            "env": {},
            "command": "/opt/venv/bin/vllm serve /model --served-model-name=GLM-5.2",
        }
        self.assertEqual(self.collector.expected_model_for("model", record), "GLM-5.2")

    def test_host_network_keeps_internal_port(self):
        record = {
            "name": "model",
            "running": True,
            "env": {},
            "command": "vllm serve /model --port 5802",
            "network_mode": "host",
            "ports": {"5802/tcp": [{"HostPort": "5810"}]},
        }
        self.assertEqual(
            self.collector.metrics_url_for("model", record),
            "http://127.0.0.1:5802/metrics",
        )

    @patch("observer.collector.subprocess.run", side_effect=subprocess.TimeoutExpired(["docker", "ps"], 8))
    def test_docker_timeout_returns_failed_result(self, _run):
        result = self.collector._run(["docker", "ps"], timeout=8)
        self.assertEqual(result.returncode, 124)
        self.assertIn("timed out", result.stderr)


if __name__ == "__main__":
    unittest.main()
