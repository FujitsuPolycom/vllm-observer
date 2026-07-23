import unittest
from unittest.mock import patch

from observer.sampler import MetricSampler


METRICS = """
vllm:prompt_tokens_total{model_name="glm-5.2"} %s
vllm:prompt_tokens_cached_total{model_name="glm-5.2"} %s
vllm:generation_tokens_total{model_name="glm-5.2"} %s
vllm:num_requests_running{model_name="glm-5.2"} 1
"""


class FakeCollector:
    def metrics_url_for(self, instance, record=None):
        return "http://model:8000/metrics"

    def expected_model_for(self, instance, record=None):
        return "glm-5.2"

    def instances(self):
        return [{"name": "model", "running": True}]


class SamplerTests(unittest.TestCase):
    def test_api_reads_do_not_change_sampling_cadence(self):
        payloads = iter([METRICS % (100, 50, 10), METRICS % (300, 150, 50)])
        sampler = MetricSampler(FakeCollector(), fetch=lambda _: next(payloads))
        with patch("observer.sampler.time.monotonic", side_effect=[10.0, 11.0]):
            self.assertEqual(sampler.sample("model")["status"], "warming")
            point = sampler.sample("model")
        self.assertEqual(point["sample_seconds"], 1.0)
        self.assertEqual(point["throughput"]["fresh_prefill_tps"], 100)
        self.assertEqual(point["throughput"]["decode_tps"], 40)
        self.assertEqual(sampler.snapshot("model")["sample_seconds"], 1.0)
        self.assertEqual(sampler.snapshot("model")["sample_seconds"], 1.0)

    def test_model_identity_mismatch_is_rejected(self):
        sampler = MetricSampler(
            FakeCollector(),
            fetch=lambda _: 'vllm:prompt_tokens_total{model_name="other-model"} 1',
        )
        point = sampler.sample("model")
        self.assertEqual(point["status"], "identity_mismatch")
        self.assertIn("glm-5.2", point["error"])


if __name__ == "__main__":
    unittest.main()
