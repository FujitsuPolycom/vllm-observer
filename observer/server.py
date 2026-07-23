"""Small standard-library HTTP server for the observer API and dashboard."""

from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .collector import Collector
from .parser import classify, metrics


ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
collector = Collector()

COMPOSE = """services:
  vllm-observer:
    image: ghcr.io/yourname/vllm-observer:latest
    container_name: vllm-observer
    restart: unless-stopped
    ports:
      - \"8088:8088\"
    environment:
      VLLM_OBSERVER_DOCKER: \"1\"
      VLLM_OBSERVER_LOG_TAIL: \"320\"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "vllm-observer/0.1"

    def _send(self, payload: object, status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, content_type: str) -> None:
        if not path.is_file() or path.parent != DASHBOARD:
            self._send({"error": "not found"}, 404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        try:
            if path == "/":
                return self._file(DASHBOARD / "index.html", "text/html; charset=utf-8")
            if path == "/api/health":
                return self._send({"ok": True, "service": "vllm-observer"})
            if path == "/api/compose":
                instance = parse_qs(parsed.query).get("instance", [""])[0]
                if instance:
                    body = collector.compose_template(instance).encode()
                    filename = f"{instance}.compose.yml"
                else:
                    body = COMPOSE.encode()
                    filename = "vllm-observer.compose.yml"
                self.send_response(200)
                self.send_header("Content-Type", "text/yaml; charset=utf-8")
                self.send_header("Content-Disposition", f"attachment; filename={filename}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if path == "/api/instances":
                return self._send({"instances": collector.instances()})
            if path == "/api/logs":
                instance = parse_qs(parsed.query).get("instance", [""])[0]
                lines = collector.logs(instance)
                return self._send({"instance": instance, "lines": lines, "metrics": metrics(lines), "live_metrics": collector.live_metrics(instance), "groups": classify(lines)})
            if path == "/api/live":
                instance = parse_qs(parsed.query).get("instance", [""])[0]
                return self._send({"instance": instance, "live_metrics": collector.live_metrics(instance)})
            if path == "/app.js":
                return self._file(DASHBOARD / "app.js", "text/javascript; charset=utf-8")
            if path == "/display.js":
                return self._file(DASHBOARD / "display.js", "text/javascript; charset=utf-8")
            if path == "/styles.css":
                return self._file(DASHBOARD / "styles.css", "text/css; charset=utf-8")
            self._send({"error": "not found"}, 404)
        except (OSError, ValueError, TimeoutError) as error:
            self._send({"error": str(error)}, 503)

    def log_message(self, format: str, *args: object) -> None:
        if os.getenv("VLLM_OBSERVER_ACCESS_LOG", "0") == "1":
            super().log_message(format, *args)


def main() -> None:
    host = os.getenv("VLLM_OBSERVER_HOST", "0.0.0.0")
    port = int(os.getenv("VLLM_OBSERVER_PORT", "8088"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"vLLM Observer listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
