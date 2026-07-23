"""Small Prometheus text-format reader for vLLM counters and gauges."""

from __future__ import annotations

import re


SAMPLE_RE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+0-9.eE]+)")


def parse(text: str) -> dict[str, float]:
    samples: dict[str, float] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = SAMPLE_RE.match(line)
        if not match:
            continue
        try:
            samples[match[1]] = float(match[2])
        except ValueError:
            continue
    return samples


def rates(previous: dict[str, float], current: dict[str, float], elapsed: float) -> dict[str, float]:
    """Calculate non-negative per-second deltas for counters seen twice."""
    if elapsed <= 0:
        return {}
    result = {}
    for name, value in current.items():
        old = previous.get(name)
        if old is not None and value >= old:
            result[name] = (value - old) / elapsed
    return result
