"""HTTP API and static dashboard for vLLM Observer."""

from __future__ import annotations

import json
import mimetypes
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .collector import Collector
from .parser import classify, metrics
from .sampler import MetricSampler


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
collector = Collector()
sampler = MetricSampler(collector)
INSTANCE_ROUTE = re.compile(r"^/api/v1/instances/([^/]+)/(snapshot|history|logs|config|report)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "vllm-observer/0.2"

    def _send(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, relative: str) -> None:
        path = (DASHBOARD / relative.lstrip("/")).resolve()
        try:
            path.relative_to(DASHBOARD.resolve())
        except ValueError:
            return self._send({"error": "not found"}, 404)
        if not path.is_file():
            return self._send({"error": "not found"}, 404)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path.name)[0] or "application/octet-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        try:
            if path == "/":
                return self._file("index.html")
            if path == "/api/v1":
                return self._send({
                    "name": "vLLM Observer API",
                    "version": "v1",
                    "endpoints": [
                        "/api/v1/status",
                        "/api/v1/instances",
                        "/api/v1/instances/{name}/snapshot",
                        "/api/v1/instances/{name}/history?limit=900",
                        "/api/v1/instances/{name}/logs",
                        "/api/v1/instances/{name}/config",
                        "/api/v1/instances/{name}/report?at=<timestamp>",
                    ],
                })
            if path in {"/api/health", "/api/v1/status"}:
                return self._send({"ok": True, **sampler.status()})
            if path in {"/api/instances", "/api/v1/instances"}:
                return self._send({"instances": collector.instances()})
            match = INSTANCE_ROUTE.match(path)
            if match:
                instance, resource = unquote(match.group(1)), match.group(2)
                return self._instance_resource(instance, resource, query)
            if path == "/api/live":
                instance = query.get("instance", [""])[0]
                return self._send({"instance": instance, "live_metrics": _legacy_live(sampler.snapshot(instance))})
            if path == "/api/logs":
                instance = query.get("instance", [""])[0]
                lines = collector.logs(instance)
                return self._send({
                    "instance": instance,
                    "lines": lines,
                    "metrics": metrics(lines),
                    "live_metrics": _legacy_live(sampler.snapshot(instance)),
                    "groups": classify(lines),
                })
            if path == "/api/compose":
                instance = query.get("instance", [""])[0]
                if not instance:
                    return self._send({"error": "choose an instance"}, 400)
                body = collector.compose_template(instance).encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/yaml; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{instance}.compose.yml"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if not path.startswith("/api/"):
                return self._file(path)
            return self._send({"error": "not found"}, 404)
        except (OSError, ValueError, TimeoutError) as error:
            return self._send({"error": str(error)}, 503)

    def _instance_resource(self, instance: str, resource: str, query: dict[str, list[str]]) -> None:
        if resource == "snapshot":
            return self._send(sampler.snapshot(instance))
        if resource == "history":
            try:
                limit = int(query.get("limit", ["900"])[0])
            except ValueError:
                limit = 900
            return self._send({"instance": instance, "points": sampler.history(instance, limit)})
        if resource == "logs":
            at = _query_timestamp(query)
            if at is not None:
                payload = sampler.logs_at(instance, at)
                payload["groups"] = classify(payload["lines"])
                return self._send(payload)
            lines = collector.logs(instance)
            return self._send({"instance": instance, "lines": lines, "groups": classify(lines)})
        if resource == "config":
            item = next((item for item in collector.instances() if item["name"] == instance), None)
            if not item:
                return self._send({"error": "unknown instance"}, 404)
            return self._send(item)
        if resource == "report":
            body = sampler.report(instance, _query_timestamp(query)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{instance}.report.html"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        if os.getenv("VLLM_OBSERVER_ACCESS_LOG", "0") == "1":
            super().log_message(format, *args)


def _legacy_live(point: dict[str, object]) -> dict[str, object]:
    throughput = point.get("throughput", {}) if point.get("status") == "ok" else {}
    cache = point.get("cache", {}) if point.get("status") == "ok" else {}
    requests = point.get("requests", {}) if point.get("status") == "ok" else {}
    return {
        "available": point.get("status") == "ok",
        "reason": point.get("error"),
        "sample_seconds": point.get("sample_seconds"),
        "source": (point.get("source") or {}).get("url") if isinstance(point.get("source"), dict) else None,
        "fresh_prefill_tokens_per_second": throughput.get("fresh_prefill_tps"),
        "cached_ingest_tokens_per_second": throughput.get("cached_total_tps"),
        "decode_tokens_per_second": throughput.get("decode_tps"),
        "cache_hit_percent": cache.get("prefix_hit_percent"),
        "running_requests": requests.get("running"),
        "waiting_requests": requests.get("waiting"),
    }


def _query_timestamp(query: dict[str, list[str]]) -> int | None:
    try:
        value = query.get("at", [""])[0]
        return int(value) if value else None
    except (TypeError, ValueError):
        return None


def main() -> None:
    host = os.getenv("VLLM_OBSERVER_HOST", "0.0.0.0")
    port = int(os.getenv("VLLM_OBSERVER_PORT", "8088"))
    sampler.start()
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"vLLM Observer listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        sampler.stop()


if __name__ == "__main__":
    main()
