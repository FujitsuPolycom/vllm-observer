import unittest

from observer.parser import classify, metrics
from observer.prometheus import parse, rates


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

    def test_performance_metrics(self):
        result = metrics(SAMPLE)
        self.assertEqual(result["prompt_tokens_per_second"], 3071.8)
        self.assertEqual(result["generation_tokens_per_second"], 64.0)
        self.assertEqual(result["speculative_depth"], 3)
        self.assertEqual(result["lmcache_hit_tokens"], 0)
        self.assertEqual(result["cache_transfer_chunks"], 12.0)

    def test_lines_are_grouped(self):
        groups = classify(SAMPLE)
        self.assertTrue(groups["lmcache"])
        self.assertTrue(groups["prefill"])
        self.assertTrue(groups["decode"])


if __name__ == "__main__":
    unittest.main()
