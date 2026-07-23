"""Best-effort parsing for common vLLM and cache-runtime log lines."""

from __future__ import annotations

import re
from typing import Iterable


def _last(lines: Iterable[str], pattern: str) -> re.Match[str] | None:
    found = None
    compiled = re.compile(pattern, re.IGNORECASE)
    for line in lines:
        match = compiled.search(line)
        if match:
            found = match
    return found


def metrics(lines: list[str]) -> dict[str, object]:
    """Return only values actually observed in the supplied log tail."""
    result: dict[str, object] = {}
    engine = _last(
        lines,
        r"Avg prompt throughput:\s*([\d.]+)\s*tokens/s,\s*"
        r"Avg generation throughput:\s*([\d.]+)\s*tokens/s,\s*"
        r"Running:\s*(\d+)\s*reqs,\s*Waiting:\s*(\d+)\s*reqs,\s*"
        r"GPU KV cache usage:\s*([\d.]+)%.*?"
        r"Prefix cache hit rate:\s*([\d.]+)%.*?"
        r"External prefix cache hit rate:\s*([\d.]+)%",
    )
    if engine:
        result["prompt_tokens_per_second"] = float(engine[1])
        result["generation_tokens_per_second"] = float(engine[2])
        result["running_requests"] = int(engine[3])
        result["waiting_requests"] = int(engine[4])
        result["gpu_kv_cache_percent"] = float(engine[5])
        result["prefix_cache_hit_percent"] = float(engine[6])
        result["external_prefix_cache_hit_percent"] = float(engine[7])

    spec = _last(
        lines,
        r"SpecDecoding metrics:.*?Mean acceptance length:\s*([\d.]+),\s*"
        r"Current speculative depth:\s*(\d+),\s*Accepted throughput:\s*"
        r"([\d.]+)\s*tokens/s,\s*Drafted throughput:\s*([\d.]+)\s*"
        r"tokens/s.*?Avg Draft acceptance rate:\s*([\d.]+)%",
    )
    if spec:
        result["speculative_mean_acceptance_length"] = float(spec[1])
        result["speculative_depth"] = int(spec[2])
        result["accepted_tokens_per_second"] = float(spec[3])
        result["drafted_tokens_per_second"] = float(spec[4])
        result["draft_acceptance_percent"] = float(spec[5])

    lmcache = _last(
        lines,
        r"Total tokens\s*([\d,]+),\s*Inference Engine computed tokens:\s*"
        r"([\d,]+),\s*LMCache hit tokens:\s*([\d,]+),\s*need to load:\s*([\d,]+)",
    )
    if lmcache:
        result["lmcache_total_tokens"] = int(lmcache[1].replace(",", ""))
        result["lmcache_computed_tokens"] = int(lmcache[2].replace(",", ""))
        result["lmcache_hit_tokens"] = int(lmcache[3].replace(",", ""))
        result["lmcache_load_tokens"] = int(lmcache[4].replace(",", ""))

    chunks = _last(lines, r"([\d.]+)\s*atomic chunks")
    if chunks:
        result["cache_transfer_chunks"] = float(chunks[1])

    return result


def classify(lines: list[str]) -> dict[str, list[str]]:
    buckets = {"lmcache": [], "prefill": [], "decode": [], "requests": [], "other": []}
    for line in lines:
        lower = line.lower()
        matched = False
        if re.search(r"lmcache|kv cache|kv transfer|prefix cache|atomic chunk|cache hit|ckv", lower):
            buckets["lmcache"].append(line)
            matched = True
        if re.search(r"prefill|prompt throughput|prompt tokens|computed tokens|input tokens", lower):
            buckets["prefill"].append(line)
            matched = True
        if re.search(r"decode|generation throughput|specdec|speculative|acceptance|drafted throughput|output tokens", lower):
            buckets["decode"].append(line)
            matched = True
        if re.search(r"post /v1/|chatcmpl|request|running:|waiting:|http/1\.[01]", lower):
            buckets["requests"].append(line)
            matched = True
        if not matched:
            buckets["other"].append(line)
    return buckets
