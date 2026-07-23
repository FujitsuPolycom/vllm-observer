"""Clock-driven vLLM metric sampling with bounded durable history."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from .collector import Collector
from .prometheus import Sample, model_names, normalize, parse_samples


class MetricSampler:
    def __init__(self, collector: Collector, fetch=None) -> None:
        self.collector = collector
        self.interval = max(0.25, float(os.getenv("VLLM_OBSERVER_SAMPLE_SECONDS", "1")))
        self.max_points = max(60, int(os.getenv("VLLM_OBSERVER_HISTORY_POINTS", "3600")))
        data_dir = os.getenv("VLLM_OBSERVER_DATA_DIR", "").strip()
        self.history_file = Path(data_dir) / "history.json" if data_dir else None
        self._fetch = fetch or self._fetch_url
        self._history: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=self.max_points)
        )
        self._previous: dict[str, tuple[float, list[Sample]]] = {}
        self._status: dict[str, dict[str, Any]] = {}
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_persist = 0.0
        self._last_inventory = 0.0
        self._inventory: list[dict[str, Any]] = []
        self._load()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="metric-sampler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=self.interval + 2)
        self._persist(force=True)

    def _run(self) -> None:
        next_sample = time.monotonic()
        while not self._stop.is_set():
            started = time.monotonic()
            self.sample_all()
            next_sample += self.interval
            if next_sample <= started:
                next_sample = started + self.interval
            self._stop.wait(max(0.0, next_sample - time.monotonic()))

    def sample_all(self) -> None:
        now = time.monotonic()
        if not self._inventory or now - self._last_inventory >= 10:
            self._inventory = [item for item in self.collector.instances() if item.get("running")]
            self._last_inventory = now
        instances = self._inventory
        for item in instances:
            self.sample(item["name"], item)
        self._persist()

    def sample(self, instance: str, record: dict[str, Any] | None = None) -> dict[str, Any]:
        wall_time = time.time()
        monotonic = time.monotonic()
        url = self.collector.metrics_url_for(instance, record)
        expected_model = self.collector.expected_model_for(instance, record)
        base = {
            "instance": instance,
            "timestamp": round(wall_time * 1000),
            "source": {"url": url, "expected_model": expected_model},
        }
        if not url:
            return self._set_status(instance, {**base, "status": "unconfigured", "error": "No metrics endpoint could be resolved"})
        try:
            current = parse_samples(self._fetch(url))
        except Exception as error:  # Network libraries raise several environment-specific subclasses.
            return self._set_status(instance, {**base, "status": "error", "error": str(error)})
        if not current:
            return self._set_status(instance, {**base, "status": "error", "error": "Metrics endpoint returned no Prometheus samples"})

        observed_models = model_names(current)
        base["source"]["observed_models"] = observed_models
        if expected_model and observed_models and not _model_matches(expected_model, observed_models):
            return self._set_status(
                instance,
                {
                    **base,
                    "status": "identity_mismatch",
                    "error": f"Expected {expected_model}; endpoint reports {', '.join(observed_models)}",
                },
            )

        previous = self._previous.get(instance)
        self._previous[instance] = (monotonic, current)
        if not previous:
            return self._set_status(instance, {**base, "status": "warming", "error": "Waiting for the next real counter sample"})

        elapsed = monotonic - previous[0]
        telemetry = normalize(previous[1], current, elapsed)
        point = {
            **base,
            "status": "ok",
            "sample_seconds": round(elapsed, 3),
            **telemetry,
        }
        with self._lock:
            self._status[instance] = point
            self._history[instance].append(point)
        return point

    def snapshot(self, instance: str) -> dict[str, Any]:
        with self._lock:
            return dict(self._status.get(instance) or {
                "instance": instance,
                "timestamp": round(time.time() * 1000),
                "status": "warming",
                "error": "Sampler has not collected this workload yet",
            })

    def history(self, instance: str, limit: int = 900) -> list[dict[str, Any]]:
        bounded = max(1, min(self.max_points, limit))
        with self._lock:
            return list(self._history.get(instance, ()))[-bounded:]

    def status(self) -> dict[str, Any]:
        with self._lock:
            latest = {name: dict(value) for name, value in self._status.items()}
        return {
            "service": "vllm-observer",
            "api_version": "v1",
            "sample_seconds": self.interval,
            "history_points": self.max_points,
            "persistence": str(self.history_file) if self.history_file else None,
            "instances": latest,
        }

    def _set_status(self, instance: str, value: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            self._status[instance] = value
        return value

    @staticmethod
    def _fetch_url(url: str) -> str:
        request = Request(url, headers={"Accept": "text/plain; version=0.0.4"})
        with urlopen(request, timeout=3) as response:
            return response.read().decode("utf-8", errors="replace")

    def _load(self) -> None:
        if not self.history_file or not self.history_file.is_file():
            return
        try:
            payload = json.loads(self.history_file.read_text(encoding="utf-8"))
            for name, points in payload.items():
                self._history[name].extend(points[-self.max_points :])
                if points:
                    self._status[name] = points[-1]
        except (OSError, ValueError, TypeError):
            return

    def _persist(self, force: bool = False) -> None:
        if not self.history_file:
            return
        now = time.monotonic()
        if not force and now - self._last_persist < 10:
            return
        self._last_persist = now
        with self._lock:
            payload = {name: list(points) for name, points in self._history.items()}
        try:
            self.history_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.history_file.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            temporary.replace(self.history_file)
        except OSError:
            return


def _model_matches(expected: str, observed: list[str]) -> bool:
    normalized = expected.lower().replace("_", "-")
    return any(
        normalized == model.lower().replace("_", "-")
        or normalized in model.lower().replace("_", "-")
        or model.lower().replace("_", "-") in normalized
        for model in observed
    )
