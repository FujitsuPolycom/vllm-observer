import unittest
import threading
import time
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

    def lmcache_url_for(self, instance, record=None):
        return ""

    def instances(self):
        return [{"name": "model", "running": True}]

    def logs(self, instance):
        return []


class SamplerTests(unittest.TestCase):
    def test_collection_uses_bounded_parallel_workers_and_reports_health(self):
        active = 0
        maximum = 0
        lock = threading.Lock()

        class ManyCollector(FakeCollector):
            def running_instances(self):
                return [{"name": f"model-{index}", "running": True} for index in range(6)]

        def fetch(_):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(0.02)
            with lock:
                active -= 1
            return METRICS % (100, 50, 10)

        with patch.dict("os.environ", {"VLLM_OBSERVER_COLLECTION_WORKERS": "3"}):
            sampler = MetricSampler(ManyCollector(), fetch=fetch)
        sampler.sample_all()
        status = sampler.status()
        self.assertGreater(maximum, 1)
        self.assertLessEqual(maximum, 3)
        self.assertEqual(status["collection"]["workers"], 3)
        self.assertEqual(len(status["collection"]["sources"]), 6)
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

    def test_lmcache_health_polled_from_http_api(self):
        """When lmcache_url_for returns a URL, the sampler polls /healthcheck, /status, /periodic-threads-health."""
        lmcache_responses = {
            "http://lmcache:8080/healthcheck": '{"status": "healthy"}',
            "http://lmcache:8080/status": '{"is_healthy": true, "engine_type": "MPCacheServer", "chunk_size": 256, "hash_algorithm": "blake3", "active_sessions": 2, "registered_gpu_ids": [0, 1], "active_prefetch_jobs": 0, "storage_manager": {"is_healthy": true}}',
            "http://lmcache:8080/periodic-threads-health": '{"healthy": true, "unhealthy_count": 0, "unhealthy_threads": []}',
            "http://lmcache:8080/version": '"0.3.1-ca79ea33"',
        }
        metrics_payloads = iter([METRICS % (100, 50, 10), METRICS % (300, 150, 50)])

        class LMPCollector(FakeCollector):
            def lmcache_url_for(self, instance, record=None):
                return "http://lmcache:8080"

        def fake_fetch(url):
            if url in lmcache_responses:
                return lmcache_responses[url]
            return next(metrics_payloads)

        def fake_fetch_json(url, timeout=2.0):
            if url in lmcache_responses:
                return __import__('json').loads(lmcache_responses[url])
            return None

        sampler = MetricSampler(LMPCollector(), fetch=fake_fetch, fetch_json=fake_fetch_json)
        with patch("observer.sampler.time.monotonic", side_effect=[10.0, 11.0]):
            sampler.sample("model")  # warming
            point = sampler.sample("model")

        health = point["lmcache_health"]
        self.assertEqual(health["url"], "http://lmcache:8080")
        self.assertEqual(health["healthcheck"]["status"], "healthy")
        self.assertTrue(health["status"]["is_healthy"])
        self.assertEqual(health["status"]["engine_type"], "MPCacheServer")
        self.assertTrue(health["status"]["storage_healthy"])
        self.assertTrue(health["periodic_threads"]["healthy"])
        self.assertEqual(health["version"], "0.3.1-ca79ea33")

    def test_lmcache_prometheus_metrics_parsed(self):
        """lmcache:* Prometheus metrics in /metrics output are parsed into lmcache_prometheus."""
        metrics_with_lmcache = (
            METRICS % (100, 50, 10) +
            'lmcache:lmcache_is_healthy 1\n'
            'lmcache:num_retrieve_requests 42\n'
            'lmcache:retrieve_hit_rate 0.85\n'
            'lmcache:local_cache_usage 1073741824\n'
        )
        payloads = iter([metrics_with_lmcache, metrics_with_lmcache.replace("42", "52").replace("0.85", "0.90")])

        class NoLMCacheCollector(FakeCollector):
            def lmcache_url_for(self, instance, record=None):
                return ""

        sampler = MetricSampler(NoLMCacheCollector(), fetch=lambda _: next(payloads))
        with patch("observer.sampler.time.monotonic", side_effect=[10.0, 11.0]):
            sampler.sample("model")
            point = sampler.sample("model")

        prom = point["lmcache_prometheus"]
        self.assertEqual(prom["is_healthy"], 1.0)
        self.assertEqual(prom["retrieve_hit_rate"], 0.9)  # gauge, takes current
        self.assertEqual(prom["local_cache_usage"], 1073741824.0)

    def test_lmcache_unreachable_returns_empty_health(self):
        """When LMCache URL is set but unreachable, health dict marks it unreachable."""
        metrics_payloads = iter([METRICS % (100, 50, 10), METRICS % (300, 150, 50)])

        class UnreachableLMCache(FakeCollector):
            def lmcache_url_for(self, instance, record=None):
                return "http://lmcache:8080"

        def fake_fetch(url):
            if "lmcache" in url:
                raise OSError("connection refused")
            return next(metrics_payloads)

        def fake_fetch_json(url, timeout=2.0):
            return None

        sampler = MetricSampler(UnreachableLMCache(), fetch=fake_fetch, fetch_json=fake_fetch_json)
        with patch("observer.sampler.time.monotonic", side_effect=[10.0, 11.0]):
            sampler.sample("model")
            point = sampler.sample("model")

        health = point["lmcache_health"]
        self.assertTrue(health.get("unreachable"))
        self.assertIsNone(health.get("healthcheck"))


if __name__ == "__main__":
    unittest.main()
