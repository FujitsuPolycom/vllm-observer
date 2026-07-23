import unittest

from observer.parser import classify, metrics
from observer.prometheus import normalize, parse, parse_samples, rates


SAMPLE = [
    "Engine 000: Avg prompt throughput: 3071.8 tokens/s, Avg generation throughput: 64.0 tokens/s, Running: 1 reqs, Waiting: 0 reqs, GPU KV cache usage: 31.7%, Prefix cache hit rate: 24.4%, External prefix cache hit rate: 20.2%",
    "SpecDecoding metrics: Mean acceptance length: 3.51, Current speculative depth: 3, Accepted throughput: 11.42 tokens/s, Drafted throughput: 13.65 tokens/s, Avg Draft acceptance rate: 83.7%",
    "LMCache INFO: Reqid: abc, Total tokens 16, Inference Engine computed tokens: 0, LMCache hit tokens: 0, need to load: 0",
    "LMCache INFO: Grouped DCP LMCache stored 12 atomic chunks",
]


class ParserTests(unittest.TestCase):
    def test_prometheus_counter_delta(self):
        previous = parse("vllm_prompt_tokens_total 100\nvllm_generation_tokens_total 20")
        current = parse("vllm_prompt_tokens_total 350\nvllm_generation_tokens_total 80")
        result = rates(previous, current, 5)
        self.assertEqual(result["vllm_prompt_tokens_total"], 50)
        self.assertEqual(result["vllm_generation_tokens_total"], 12)

    def test_labeled_prometheus_normalizes_vllm_pipeline(self):
        before = parse_samples("""
vllm:prompt_tokens_total{model_name="glm-5.2"} 100
vllm:prompt_tokens_cached_total{model_name="glm-5.2"} 60
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="local_compute"} 40
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="local_cache_hit"} 50
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="external_kv_transfer"} 10
vllm:generation_tokens_total{model_name="glm-5.2"} 20
vllm:prefix_cache_queries_total{model_name="glm-5.2"} 80
vllm:prefix_cache_hits_total{model_name="glm-5.2"} 40
vllm:external_prefix_cache_queries_total{model_name="glm-5.2"} 10
vllm:external_prefix_cache_hits_total{model_name="glm-5.2"} 5
vllm:spec_decode_num_draft_tokens_total{model_name="glm-5.2"} 12
vllm:spec_decode_num_accepted_tokens_total{model_name="glm-5.2"} 8
vllm:kv_cache_usage_perc{model_name="glm-5.2"} 0.25
vllm:num_requests_running{model_name="glm-5.2"} 2
vllm:num_requests_waiting{model_name="glm-5.2"} 1
""")
        after = parse_samples("""
vllm:prompt_tokens_total{model_name="glm-5.2"} 300
vllm:prompt_tokens_cached_total{model_name="glm-5.2"} 180
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="local_compute"} 120
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="local_cache_hit"} 150
vllm:prompt_tokens_by_source_total{model_name="glm-5.2",source="external_kv_transfer"} 30
vllm:generation_tokens_total{model_name="glm-5.2"} 60
vllm:prefix_cache_queries_total{model_name="glm-5.2"} 180
vllm:prefix_cache_hits_total{model_name="glm-5.2"} 90
vllm:external_prefix_cache_queries_total{model_name="glm-5.2"} 30
vllm:external_prefix_cache_hits_total{model_name="glm-5.2"} 15
vllm:spec_decode_num_draft_tokens_total{model_name="glm-5.2"} 32
vllm:spec_decode_num_accepted_tokens_total{model_name="glm-5.2"} 18
vllm:kv_cache_usage_perc{model_name="glm-5.2"} 0.5
vllm:num_requests_running{model_name="glm-5.2"} 3
vllm:num_requests_waiting{model_name="glm-5.2"} 0
""")
        result = normalize(before, after, 2)
        self.assertEqual(result["models"], ["glm-5.2"])
        self.assertEqual(result["throughput"]["fresh_prefill_tps"], 40)
        self.assertEqual(result["throughput"]["cached_local_tps"], 50)
        self.assertEqual(result["throughput"]["external_cache_tps"], 10)
        self.assertEqual(result["throughput"]["decode_tps"], 20)
        self.assertEqual(result["cache"]["kv_usage_percent"], 50)
        self.assertEqual(result["cache"]["prefix_hit_percent"], 50)
        self.assertEqual(result["speculative"]["draft_tps"], 10)
        self.assertEqual(result["speculative"]["accepted_tps"], 5)
        self.assertEqual(result["requests"]["running"], 3)

    def test_performance_metrics(self):
        result = metrics(SAMPLE)
        self.assertEqual(result["prompt_tokens_per_second"], 3071.8)
        self.assertEqual(result["generation_tokens_per_second"], 64.0)
        self.assertEqual(result["speculative_depth"], 3)
        self.assertEqual(result["lmcache_hit_tokens"], 0)
        self.assertEqual(result["cache_transfer_chunks"], 12.0)

    def test_request_analytics_uses_prometheus_histograms(self):
        current = parse_samples("""
vllm:prompt_tokens_total 1000
vllm:generation_tokens_total 200
vllm:request_success_total 4
vllm:num_preemptions_total 2
vllm:time_to_first_token_seconds_bucket{le="1"} 2
vllm:time_to_first_token_seconds_bucket{le="2"} 3
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 4
vllm:time_to_first_token_seconds_sum 5
vllm:time_to_first_token_seconds_count 4
""")
        result = normalize([], current, 1)
        analytics = result["request_analytics"]
        self.assertEqual(analytics["totals"]["prompt_tokens"], 1000)
        self.assertEqual(analytics["totals"]["preemptions"], 2)
        self.assertEqual(analytics["time_to_first_token"]["p50"], 1)
        self.assertEqual(analytics["time_to_first_token"]["p99"], 2)

    def test_lines_are_grouped(self):
        groups = classify(SAMPLE)
        self.assertTrue(groups["lmcache"])
        self.assertTrue(groups["prefill"])
        self.assertTrue(groups["decode"])


if __name__ == "__main__":
    unittest.main()
