"""HTTP API and static dashboard for vLLM Observer."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import base64
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .collector import Collector
from .config import ServerConfig, build_info
from .parser import classify, metrics
from .sampler import MetricSampler


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
collector = Collector()
sampler = MetricSampler(collector)
INSTANCE_ROUTE = re.compile(r"^/api/v1/instances/([^/]+)/(snapshot|history|analytics|logs|config|report)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "vllm-observer/0.2"

    def _send(self, payload: object, status: int = 200) -> None:
        if isinstance(payload, dict) and "error" in payload and "code" not in payload:
            payload = {**payload, "code": "not_found" if status == 404 else "invalid_request" if status == 400 else "source_unavailable" if status == 503 else "error"}
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors_header()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors_header(self) -> None:
        origin = self.headers.get("Origin", "")
        allowed = ServerConfig.from_env().cors_origins
        if origin and (origin in allowed or "*" in allowed):
            self.send_header("Access-Control-Allow-Origin", origin if origin != "null" else "null")
            self.send_header("Vary", "Origin")

    def _authorized(self, path: str) -> bool:
        if path == "/api/health":
            return True
        config = ServerConfig.from_env()
        if not config.auth_token and not config.auth_username:
            return True
        supplied = self.headers.get("Authorization", "")
        if config.auth_token and supplied.startswith("Bearer "):
            return hmac.compare_digest(supplied[7:], config.auth_token)
        if config.auth_username and supplied.startswith("Basic "):
            expected = base64.b64encode(f"{config.auth_username}:{config.auth_password}".encode()).decode()
            return hmac.compare_digest(supplied[6:], expected)
        return False

    def _authentication_required(self) -> None:
        body = b'{"error":"authentication required","code":"unauthorized"}'
        self.send_response(401)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        if ServerConfig.from_env().auth_username:
            self.send_header("WWW-Authenticate", 'Basic realm="vLLM Observer"')
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
            if not self._authorized(path):
                return self._authentication_required()
            if path == "/":
                return self._file("index.html")
            if path == "/api/v1":
                return self._send({
                    "name": "vLLM Observer API",
                    "version": "v1",
                    "build": build_info(),
                    "endpoints": [
                        "/api/v1/status",
                        "/api/v1/schema",
                        "/api/v1/instances",
                        "/api/v1/instances/{name}/snapshot",
                        "/api/v1/instances/{name}/history?limit=900",
                        "/api/v1/instances/{name}/analytics?limit=10080",
                        "/api/v1/instances/{name}/logs",
                        "/api/v1/instances/{name}/config",
                        "/api/v1/instances/{name}/report?at=<timestamp>",
                    ],
                })
            if path == "/api/v1/schema":
                return self._send(API_SCHEMA)
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
        if resource == "analytics":
            try:
                limit = int(query.get("limit", [str(sampler.max_analytics_points)])[0])
            except ValueError:
                limit = sampler.max_analytics_points
            return self._send({"instance": instance, "points": sampler.analytics_history(instance, limit)})
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


API_SCHEMA = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "vLLM Observer API v1",
    "type": "object",
    "contracts": {
        "status": {
            "type": "object",
            "required": ["ok", "service", "api_version", "build", "collection", "instances"],
            "properties": {
                "ok": {"type": "boolean"},
                "service": {"const": "vllm-observer"},
                "api_version": {"const": "v1"},
                "build": {"type": "object"},
                "collection": {"type": "object"},
                "instances": {"type": "object"},
            },
        },
        "instances": {
            "type": "object",
            "required": ["instances"],
            "properties": {"instances": {"type": "array"}},
        },
        "error": {
            "type": "object",
            "required": ["error"],
            "properties": {"error": {"type": "string"}, "code": {"type": "string"}},
        },
    },
}


def main() -> None:
    config = ServerConfig.from_env()
    host, port = config.host, config.port
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
