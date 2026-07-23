"""Prometheus text parsing and normalized vLLM telemetry."""

from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Iterable


SAMPLE_RE = re.compile(
    r'^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+([-+0-9.eE]+)(?:\s+\d+)?$'
)
LABEL_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"')


@dataclass(frozen=True)
class Sample:
    name: str
    labels: dict[str, str]
    value: float


def parse_samples(text: str) -> list[Sample]:
    result: list[Sample] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = SAMPLE_RE.match(line)
        if not match:
            continue
        try:
            value = float(match.group(3))
        except ValueError:
            continue
        labels = {
            key: bytes(value, "utf-8").decode("unicode_escape")
            for key, value in LABEL_RE.findall(match.group(2) or "")
        }
        result.append(Sample(match.group(1), labels, value))
    return result


def parse(text: str) -> dict[str, float]:
    """Compatibility helper that aggregates all label sets by metric name."""
    result: dict[str, float] = {}
    for sample in parse_samples(text):
        result[sample.name] = result.get(sample.name, 0.0) + sample.value
    return result


def _total(samples: Iterable[Sample], *names: str, labels: dict[str, str] | None = None) -> float | None:
    matched = [
        sample.value
        for sample in samples
        if sample.name in names
        and (not labels or all(sample.labels.get(key) == value for key, value in labels.items()))
    ]
    return sum(matched) if matched else None


def _delta(
    previous: list[Sample],
    current: list[Sample],
    elapsed: float,
    *names: str,
    labels: dict[str, str] | None = None,
) -> float | None:
    before = _total(previous, *names, labels=labels)
    after = _total(current, *names, labels=labels)
    if before is None or after is None or elapsed <= 0 or after < before:
        return None
    return (after - before) / elapsed


def rates(previous: dict[str, float], current: dict[str, float], elapsed: float) -> dict[str, float]:
    """Compatibility helper for non-negative counter deltas."""
    if elapsed <= 0:
        return {}
    return {
        name: (value - previous[name]) / elapsed
        for name, value in current.items()
        if name in previous and value >= previous[name]
    }


def model_names(samples: Iterable[Sample]) -> list[str]:
    return sorted(
        {
            sample.labels["model_name"]
            for sample in samples
            if sample.labels.get("model_name")
        }
    )


def normalize(previous: list[Sample], current: list[Sample], elapsed: float) -> dict[str, object]:
    """Convert vLLM counters and gauges into dashboard-ready telemetry."""
    counter = lambda *names, labels=None: _delta(previous, current, elapsed, *names, labels=labels)
    gauge = lambda *names, labels=None: _total(current, *names, labels=labels)

    prompt = counter("vllm:prompt_tokens_total", "vllm_prompt_tokens_total")
    cached = counter("vllm:prompt_tokens_cached_total", "vllm_prompt_tokens_cached_total")
    decode = counter("vllm:generation_tokens_total", "vllm_generation_tokens_total")
    local_compute = counter(
        "vllm:prompt_tokens_by_source_total",
        labels={"source": "local_compute"},
    )
    local_cache = counter(
        "vllm:prompt_tokens_by_source_total",
        labels={"source": "local_cache_hit"},
    )
    external_cache = counter(
        "vllm:prompt_tokens_by_source_total",
        labels={"source": "external_kv_transfer"},
    )

    fresh = local_compute if local_compute is not None else (
        max(0.0, prompt - cached) if prompt is not None and cached is not None else None
    )
    cached_local = local_cache if local_cache is not None else (
        max(0.0, cached - (external_cache or 0.0)) if cached is not None else None
    )

    throughput = {
        "fresh_prefill_tps": fresh,
        "cached_local_tps": cached_local,
        "external_cache_tps": external_cache,
        "cached_total_tps": cached,
        "decode_tps": decode,
        "ingest_total_tps": prompt,
    }

    prefix_queries = counter("vllm:prefix_cache_queries_total")
    prefix_hits = counter("vllm:prefix_cache_hits_total")
    external_queries = counter("vllm:external_prefix_cache_queries_total")
    external_hits = counter("vllm:external_prefix_cache_hits_total")
    draft_tokens = counter("vllm:spec_decode_num_draft_tokens_total")
    accepted_tokens = counter("vllm:spec_decode_num_accepted_tokens_total")

    prompt_total = _total(current, "vllm:prompt_tokens_total", "vllm_prompt_tokens_total")
    generation_total = _total(current, "vllm:generation_tokens_total", "vllm_generation_tokens_total")
    completed_total = _total(current, "vllm:request_success_total", "vllm_request_success_total")
    preemptions_total = _total(current, "vllm:num_preemptions_total", "vllm_num_preemptions_total")
    analytics = _request_analytics(current, prompt_total, generation_total, completed_total, preemptions_total)

    cache = {
        "kv_usage_percent": _percent(gauge("vllm:kv_cache_usage_perc")),
        "prefix_hit_percent": _ratio(prefix_hits, prefix_queries),
        "external_prefix_hit_percent": _ratio(external_hits, external_queries),
    }
    speculative = {
        "draft_tps": draft_tokens,
        "accepted_tps": accepted_tokens,
        "acceptance_percent": _ratio(accepted_tokens, draft_tokens),
    }
    requests = {
        "running": gauge("vllm:num_requests_running"),
        "waiting": gauge("vllm:num_requests_waiting"),
        "completed_per_second": counter("vllm:request_success_total"),
    }

    return {
        "throughput": _without_none(throughput),
        "cache": _without_none(cache),
        "speculative": _without_none(speculative),
        "requests": _without_none(requests),
        "request_analytics": analytics,
        "models": model_names(current),
        "capabilities": {
            "prompt_source_breakdown": local_compute is not None,
            "prefix_cache": prefix_queries is not None,
            "external_cache": external_queries is not None or external_cache is not None,
            "speculative_decoding": draft_tokens is not None,
        },
    }


def _request_analytics(
    samples: list[Sample],
    prompt_total: float | None,
    generation_total: float | None,
    completed_total: float | None,
    preemptions_total: float | None,
) -> dict[str, object]:
    """Expose request-level metrics without deriving them from logger snapshots."""
    analytics: dict[str, object] = {
        "totals": _without_none({
            "prompt_tokens": prompt_total,
            "generation_tokens": generation_total,
            "completed_requests": completed_total,
            "preemptions": preemptions_total,
        }),
    }
    histograms = {
        "time_to_first_token": "vllm:time_to_first_token_seconds",
        "end_to_end": "vllm:e2e_request_latency_seconds",
        "inter_token": "vllm:inter_token_latency_seconds",
        "prompt_size": "vllm:request_prompt_tokens",
        "output_size": "vllm:request_generation_tokens",
        "queue_time": "vllm:request_queue_time_seconds",
        "prefill_time": "vllm:request_prefill_time_seconds",
        "decode_time": "vllm:request_decode_time_seconds",
    }
    for key, prefix in histograms.items():
        value = _histogram_summary(samples, prefix)
        if value:
            analytics[key] = value

    spec = {
        "accepted_tokens": _total(samples, "vllm:spec_decode_num_accepted_tokens_total"),
        "drafted_tokens": _total(samples, "vllm:spec_decode_num_draft_tokens_total"),
        "drafts": _total(samples, "vllm:spec_decode_num_drafts_total"),
    }
    spec = _without_none(spec)
    if spec:
        analytics["speculative"] = spec
    start = _total(samples, "vllm:process_start_time_seconds", "process_start_time_seconds")
    if start is not None:
        analytics["uptime_seconds"] = max(0.0, time.time() - start)
    return analytics


def _histogram_summary(samples: list[Sample], prefix: str) -> dict[str, object]:
    names = {prefix, prefix.replace(":", "_")}
    buckets: dict[float, float] = {}
    total_sum = None
    total_count = None
    for sample in samples:
        if sample.name in {f"{name}_bucket" for name in names}:
            bound = sample.labels.get("le")
            if bound is None:
                continue
            try:
                buckets[float(bound)] = buckets.get(float(bound), 0.0) + sample.value
            except ValueError:
                continue
        elif sample.name in {f"{name}_sum" for name in names}:
            total_sum = (total_sum or 0.0) + sample.value
        elif sample.name in {f"{name}_count" for name in names}:
            total_count = (total_count or 0.0) + sample.value
    if not buckets and total_count is None:
        return {}
    result: dict[str, object] = _without_none({"count": total_count, "sum": total_sum})
    if total_count and total_count > 0:
        for percentile, label in ((0.5, "p50"), (0.9, "p90"), (0.95, "p95"), (0.99, "p99")):
            result[label] = _histogram_quantile(buckets, total_count * percentile)
        if total_sum is not None:
            result["average"] = total_sum / total_count
    return result


def _histogram_quantile(buckets: dict[float, float], rank: float) -> float | None:
    running = 0.0
    finite = [(bound, count) for bound, count in sorted(buckets.items()) if bound != float("inf")]
    for bound, count in finite:
        running = max(running, count)
        if running >= rank:
            return bound
    return finite[-1][0] if finite else None


def _ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None:
        return None
    return (numerator / denominator * 100.0) if denominator > 0 else 0.0


def _percent(value: float | None) -> float | None:
    return value * 100.0 if value is not None else None


def _without_none(values: dict[str, float | None]) -> dict[str, float]:
    return {key: value for key, value in values.items() if value is not None}
