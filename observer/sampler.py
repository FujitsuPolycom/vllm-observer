"""Clock-driven vLLM metric sampling with bounded durable history."""

from __future__ import annotations

import json
import os
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
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
        self.analytics_interval = max(10.0, float(os.getenv("VLLM_OBSERVER_ANALYTICS_SAMPLE_SECONDS", "60")))
        self.analytics_age_seconds = max(3600, int(os.getenv("VLLM_OBSERVER_ANALYTICS_HISTORY_SECONDS", "604800")))
        self.max_analytics_points = max(60, int(self.analytics_age_seconds / self.analytics_interval) + 1)
        self.log_interval = max(1.0, float(os.getenv("VLLM_OBSERVER_LOG_SAMPLE_SECONDS", "3")))
        default_log_points = int(604800 / self.log_interval) + 1
        self.max_log_points = max(20, int(os.getenv("VLLM_OBSERVER_LOG_HISTORY_POINTS", str(default_log_points))))
        self.max_log_age_seconds = max(60, int(os.getenv("VLLM_OBSERVER_LOG_HISTORY_SECONDS", "604800")))
        self.log_context_seconds = max(1, int(os.getenv("VLLM_OBSERVER_LOG_CONTEXT_SECONDS", "30")))
        self.log_context_lines = max(20, int(os.getenv("VLLM_OBSERVER_LOG_CONTEXT_LINES", "1000")))
        self.max_log_bytes = max(1_000_000, int(os.getenv("VLLM_OBSERVER_LOG_HISTORY_MAX_BYTES", "50000000")))
        data_dir = os.getenv("VLLM_OBSERVER_DATA_DIR", "").strip()
        self.history_file = Path(data_dir) / "history.json" if data_dir else None
        self.analytics_file = Path(data_dir) / "analytics-history.json" if data_dir else None
        self.log_history_file = Path(data_dir) / "log-history.json" if data_dir else None
        self._fetch = fetch or self._fetch_url
        self._history: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=self.max_points)
        )
        self._analytics_history: dict[str, deque[dict[str, Any]]] = defaultdict(
            lambda: deque(maxlen=self.max_analytics_points)
        )
        self._previous: dict[str, tuple[float, list[Sample]]] = {}
        self._status: dict[str, dict[str, Any]] = {}
        self._log_history: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
        self._seen_log_keys: dict[str, set[str]] = defaultdict(set)
        self._seen_log_order: dict[str, deque[str]] = defaultdict(deque)
        self._log_bytes_total = 0
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_persist = 0.0
        self._last_log_capture = 0.0
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
            discover = getattr(self.collector, "running_instances", self.collector.instances)
            self._inventory = [item for item in discover() if item.get("running")]
            self._last_inventory = now
        instances = self._inventory
        for item in instances:
            self.sample(item["name"], item)
        if now - self._last_log_capture >= self.log_interval:
            self._capture_logs(instances)
            self._last_log_capture = now
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
            return self._set_status(instance, {**base, "status": "unconfigured", "error": "No metrics endpoint could be resolved for this container. Set PORT/VLLM_PORT env or --port flag on the workload, or configure VLLM_OBSERVER_METRICS_URL or VLLM_OBSERVER_METRICS_URL_<INSTANCE>."})
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
            analytics = point.get("request_analytics")
            if analytics and (
                not self._analytics_history[instance]
                or point["timestamp"] - self._analytics_history[instance][-1]["timestamp"]
                >= self.analytics_interval * 1000
            ):
                self._analytics_history[instance].append({
                    "timestamp": point["timestamp"],
                    "request_analytics": analytics,
                })
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

    def analytics_history(self, instance: str, limit: int | None = None) -> list[dict[str, Any]]:
        bounded = self.max_analytics_points if limit is None else max(1, min(self.max_analytics_points, limit))
        with self._lock:
            points = list(self._analytics_history.get(instance, ()))
            return points[-bounded:]

    def logs_at(self, instance: str, timestamp: int | None = None) -> dict[str, Any]:
        """Return the nearest archived log tail and the line nearest the selected point."""
        target = timestamp or round(time.time() * 1000)
        with self._lock:
            points = list(self._log_history.get(instance, ()))
        if points:
            archive = min(points, key=lambda point: abs(point["timestamp"] - target))
            delta = abs(archive["timestamp"] - target)
            nearby = [
                point for point in points
                if abs(point["timestamp"] - target) <= self.log_context_seconds * 1000
            ]
            if not nearby:
                nearby = [archive]
            lines = []
            for point in nearby:
                lines.extend(point["lines"])
            lines = list(dict.fromkeys(lines))[-self.log_context_lines:]
        else:
            lines = self.collector.logs(instance)
            archive = {"timestamp": round(time.time() * 1000), "lines": lines}
            delta = abs(archive["timestamp"] - target)
        return {
            "instance": instance,
            "target_timestamp": target,
            "archive_timestamp": archive["timestamp"],
            "archive_delta_seconds": round(delta / 1000, 2),
            "context_seconds": self.log_context_seconds,
            "lines": lines,
            "focus_line": _nearest_log_line(lines, target),
        }

    def report(self, instance: str, timestamp: int | None = None) -> str:
        target = timestamp or round(time.time() * 1000)
        point = min(
            self.history(instance, self.max_points),
            key=lambda item: abs(item["timestamp"] - target),
            default=self.snapshot(instance),
        )
        log_data = self.logs_at(instance, target)
        inventory = [item for item in self.collector.instances() if item.get("running")]
        selected = next((item for item in inventory if item["name"] == instance), None)
        generated = datetime.now(timezone.utc).isoformat()
        title = f"vLLM Observer report - {instance} - {datetime.fromtimestamp(target / 1000, timezone.utc).isoformat()}"
        sections = [
            f"<h1>{_html(title)}</h1>",
            f"<p class=meta>Generated {_html(generated)} · target {_html(str(target))} · log archive delta {_html(str(log_data['archive_delta_seconds']))} seconds</p>",
            _report_section("Telemetry point", _pretty_json(point)),
            _report_section("Selected workload", _pretty_json(selected or {"name": instance, "error": "not running in inventory"})),
            _report_section("Running workloads", _pretty_json(inventory)),
            _report_section("Logs near selected point", "\n".join(_html(line) for line in log_data["lines"])),
        ]
        styles = "body{font:14px system-ui,sans-serif;max-width:1200px;margin:32px auto;padding:0 20px;color:#172124}h1{font-size:24px}.meta{color:#657175}section{margin:24px 0}h2{font-size:16px;border-bottom:1px solid #dce2e1;padding-bottom:8px}pre{white-space:pre-wrap;overflow:auto;padding:14px;background:#f3f5f5;border:1px solid #dce2e1;border-radius:4px;font:12px/1.5 ui-monospace,monospace}"
        return f"<!doctype html><html><head><meta charset=utf-8><title>{_html(title)}</title><style>{styles}</style></head><body>{''.join(sections)}</body></html>"

    def status(self) -> dict[str, Any]:
        with self._lock:
            latest = {name: dict(value) for name, value in self._status.items()}
        return {
            "service": "vllm-observer",
            "api_version": "v1",
            "sample_seconds": self.interval,
            "history_points": self.max_points,
            "analytics_sample_seconds": self.analytics_interval,
            "analytics_history_seconds": self.analytics_age_seconds,
            "analytics_history_points": self.max_analytics_points,
            "persistence": str(self.history_file) if self.history_file else None,
            "log_sample_seconds": self.log_interval,
            "log_history_seconds": self.max_log_age_seconds,
            "log_history_points": self.max_log_points,
            "log_history_max_bytes": self.max_log_bytes,
            "log_history_estimated_bytes": self._log_bytes(),
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
        if self.history_file and self.history_file.is_file():
            try:
                payload = json.loads(self.history_file.read_text(encoding="utf-8"))
                for name, points in payload.items():
                    self._history[name].extend(points[-self.max_points :])
                    if points:
                        self._status[name] = points[-1]
            except (OSError, ValueError, TypeError):
                pass
        if self.analytics_file and self.analytics_file.is_file():
            try:
                payload = json.loads(self.analytics_file.read_text(encoding="utf-8"))
                cutoff = round(time.time() * 1000) - self.analytics_age_seconds * 1000
                for name, points in payload.items():
                    valid = [point for point in points if isinstance(point, dict) and point.get("timestamp", 0) >= cutoff]
                    self._analytics_history[name].extend(valid[-self.max_analytics_points :])
            except (OSError, ValueError, TypeError):
                pass
        if self.log_history_file and self.log_history_file.is_file():
            try:
                payload = json.loads(self.log_history_file.read_text(encoding="utf-8"))
                for name, points in payload.items():
                    for point in points:
                        if isinstance(point, dict) and isinstance(point.get("lines"), list):
                            self._log_history[name].append(point)
                            self._log_bytes_total += self._entry_bytes(point)
                with self._lock:
                    self._trim_log_history_locked(round(time.time() * 1000))
            except (OSError, ValueError, TypeError):
                pass

    def _persist(self, force: bool = False) -> None:
        now = time.monotonic()
        if not force and now - self._last_persist < 10:
            return
        self._last_persist = now
        with self._lock:
            payload = {name: list(points) for name, points in self._history.items()}
            analytics_payload = {name: list(points) for name, points in self._analytics_history.items()}
            self._trim_log_history_locked(round(time.time() * 1000))
            log_payload = {name: list(points) for name, points in self._log_history.items()}
        if self.history_file:
            try:
                self.history_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.history_file.with_suffix(".tmp")
                temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
                temporary.replace(self.history_file)
            except OSError:
                pass
        if self.analytics_file:
            try:
                self.analytics_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.analytics_file.with_suffix(".tmp")
                temporary.write_text(json.dumps(analytics_payload, separators=(",", ":")), encoding="utf-8")
                temporary.replace(self.analytics_file)
            except OSError:
                pass
        if self.log_history_file:
            try:
                self.log_history_file.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.log_history_file.with_suffix(".tmp")
                temporary.write_text(json.dumps(log_payload, separators=(",", ":")), encoding="utf-8")
                temporary.replace(self.log_history_file)
            except OSError:
                pass

    def _capture_logs(self, instances: list[dict[str, Any]]) -> None:
        captured_at = round(time.time() * 1000)
        for item in instances:
            try:
                lines = self.collector.logs(item["name"])
            except (OSError, ValueError, TimeoutError):
                continue
            with self._lock:
                name = item["name"]
                seen = self._seen_log_keys[name]
                order = self._seen_log_order[name]
                new_lines = []
                for line in lines:
                    key = _log_key(line)
                    if key in seen:
                        continue
                    seen.add(key)
                    order.append(key)
                    while len(order) > 20000:
                        seen.discard(order.popleft())
                    new_lines.append(line)
                if new_lines:
                    entry = {"timestamp": captured_at, "lines": new_lines}
                    self._log_history[name].append(entry)
                    self._log_bytes_total += self._entry_bytes(entry)
                    self._trim_log_history_locked(captured_at)

    def _log_bytes(self) -> int:
        with self._lock:
            return self._log_bytes_total

    def _trim_log_history_locked(self, now_ms: int) -> None:
        cutoff = now_ms - self.max_log_age_seconds * 1000
        for points in self._log_history.values():
            while points and (
                points[0]["timestamp"] < cutoff
                or len(points) > self.max_log_points
            ):
                self._log_bytes_total -= self._entry_bytes(points.popleft())
        while self._log_bytes_total > self.max_log_bytes:
            candidates = [(points[0]["timestamp"], name) for name, points in self._log_history.items() if points]
            if not candidates:
                break
            _, oldest_name = min(candidates)
            self._log_bytes_total -= self._entry_bytes(self._log_history[oldest_name].popleft())

    @staticmethod
    def _entry_bytes(entry: dict[str, Any]) -> int:
        return len(json.dumps(entry, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def _model_matches(expected: str, observed: list[str]) -> bool:
    normalized = expected.lower().replace("_", "-")
    return any(
        normalized == model.lower().replace("_", "-")
        or normalized in model.lower().replace("_", "-")
        or model.lower().replace("_", "-") in normalized
        for model in observed
    )


def _nearest_log_line(lines: list[str], timestamp: int) -> str | None:
    if not lines:
        return None
    target = timestamp / 1000
    best_line = lines[-1]
    best_distance = float("inf")
    for line in lines:
        stamp = _log_timestamp(line)
        if stamp is None:
            continue
        distance = abs(stamp - target)
        if distance < best_distance:
            best_line, best_distance = line, distance
    return best_line


def _log_timestamp(line: str) -> float | None:
    value = line.split(" ", 1)[0]
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _log_key(line: str) -> str:
    timestamp = line.split(" ", 1)[0]
    return f"timestamp:{timestamp}|{line}" if _log_timestamp(line) is not None else f"line:{line}"


def _html(value: object) -> str:
    import html
    return html.escape(str(value), quote=True)


def _pretty_json(value: object) -> str:
    return _html(json.dumps(value, indent=2, ensure_ascii=True, default=str))


def _report_section(title: str, body: str) -> str:
    return f"<section><h2>{_html(title)}</h2><pre>{body}</pre></section>"
