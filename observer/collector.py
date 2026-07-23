"""Bounded, read-only workload and log discovery."""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
SECRET_RE = re.compile(r"(?i)(bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+")
IDENT_RE = re.compile(r"^[a-zA-Z0-9_.-]{1,128}$")
VLLM_TERMS = ("vllm", "lmcache", "sglang", "triton", "serve-glm", "glm52", "deepseek", "llama-server")


def clean(line: str) -> str:
    return SECRET_RE.sub(r"\1[redacted]", ANSI_RE.sub("", line).replace("\r", ""))


class Collector:
    def __init__(self) -> None:
        self.tail = min(1000, max(20, int(os.getenv("VLLM_OBSERVER_LOG_TAIL", "320"))))
        self.docker_enabled = os.getenv("VLLM_OBSERVER_DOCKER", "1").lower() not in {"0", "false", "no"}
        self.allowlist = {x.strip() for x in os.getenv("VLLM_OBSERVER_CONTAINER_ALLOWLIST", "").split(",") if x.strip()}
        self.paths = [Path(x.strip()) for x in os.getenv("VLLM_OBSERVER_LOG_PATHS", "").split(",") if x.strip()]
        self.metrics_url = os.getenv("VLLM_OBSERVER_METRICS_URL", "").strip()
        self.metrics_host = os.getenv("VLLM_OBSERVER_METRICS_HOST", "127.0.0.1").strip()

    def _run(self, args: list[str], timeout: int = 8) -> subprocess.CompletedProcess[str]:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)

    def _inspect(self, name: str) -> dict[str, Any] | None:
        if not IDENT_RE.fullmatch(name):
            return None
        result = self._run(["docker", "inspect", name])
        if result.returncode:
            return None
        try:
            return json.loads(result.stdout)[0]
        except (ValueError, IndexError, TypeError):
            return None

    def _is_vllm(self, info: dict[str, Any]) -> bool:
        config = info.get("Config", {})
        command = " ".join((config.get("Entrypoint") or []) + (config.get("Cmd") or []))
        labels = " ".join((config.get("Labels") or {}).keys())
        haystack = " ".join([info.get("Name", ""), config.get("Image", ""), command, labels]).lower()
        if "observer" in haystack or "vllm-observer" in haystack:
            return False
        return any(term in haystack for term in VLLM_TERMS)

    def _env(self, values: list[str] | None) -> dict[str, str]:
        prefixes = (
            "VLLM_", "LMCACHE_", "KV_", "MODEL", "SERVED_MODEL", "MAX_", "TP", "DCP",
            "MTP", "PORT", "QUANT", "MOE", "CUDA_", "NCCL_", "GPU_", "GPUS", "LOAD_",
            "GRAPH", "ALLREDUCE_", "ONLINE_", "B12X_", "INSTANTTENSOR_", "FLASHINFER_",
            "TORCH_", "XDG_", "F8_",
        )
        selected = {}
        for entry in values or []:
            key, _, value = entry.partition("=")
            if not key.startswith(prefixes):
                continue
            upper = key.upper()
            if any(word in upper for word in ("PASSWORD", "SECRET", "API_KEY")) or upper in {"HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "ACCESS_TOKEN", "AUTH_TOKEN"}:
                value = "[redacted]"
            selected[key] = value
        return dict(sorted(selected.items()))

    def _record(self, info: dict[str, Any]) -> dict[str, Any]:
        config, state = info.get("Config", {}), info.get("State", {})
        network, host = info.get("NetworkSettings", {}), info.get("HostConfig", {})
        return {
            "source": "docker",
            "name": info.get("Name", "").lstrip("/"),
            "id": info.get("Id", "")[:12],
            "image": config.get("Image", ""),
            "command": " ".join((config.get("Entrypoint") or []) + (config.get("Cmd") or [])),
            "command_parts": (config.get("Entrypoint") or []) + (config.get("Cmd") or []),
            "status": state.get("Status", "unknown"),
            "running": bool(state.get("Running")),
            "started_at": state.get("StartedAt", ""),
            "finished_at": state.get("FinishedAt", ""),
            "exit_code": state.get("ExitCode"),
            "pid": state.get("Pid"),
            "network_mode": host.get("NetworkMode", ""),
            "ipc_mode": host.get("IpcMode", ""),
            "shm_size": host.get("ShmSize", 0),
            "device_requests": host.get("DeviceRequests") or [],
            "restart_policy": (host.get("RestartPolicy") or {}).get("Name", ""),
            "env": self._env(config.get("Env")),
            "ports": network.get("Ports") or {},
            "mounts": [{"source": mount.get("Source", ""), "destination": mount.get("Destination", ""), "mode": mount.get("Mode", "ro")} for mount in info.get("Mounts", [])],
        }

    def docker_instances(self) -> list[dict[str, Any]]:
        if not self.docker_enabled:
            return []
        result = self._run(["docker", "ps", "-a", "--format", "{{.Names}}"], timeout=8)
        if result.returncode:
            return []
        found = []
        for name in result.stdout.splitlines():
            name = name.strip()
            if not name or (self.allowlist and name not in self.allowlist):
                continue
            info = self._inspect(name)
            if info and self._is_vllm(info):
                found.append(self._record(info))
        return sorted(found, key=lambda item: (not item["running"], item["name"].lower()))

    def file_instances(self) -> list[dict[str, Any]]:
        found = []
        for root in self.paths:
            files = [root] if root.is_file() else list(root.glob("*.log")) if root.is_dir() else []
            for path in files[:100]:
                found.append({"source": "file", "name": path.name, "id": str(path), "image": "log file", "status": "available", "running": True, "env": {}})
        return found

    def instances(self) -> list[dict[str, Any]]:
        return self.docker_instances() + self.file_instances()

    def logs(self, instance: str) -> list[str]:
        if not IDENT_RE.fullmatch(instance):
            raise ValueError("invalid instance")
        docker = next((item for item in self.docker_instances() if item["name"] == instance), None)
        if docker:
            result = self._run(["docker", "logs", "--timestamps", "--tail", str(self.tail), instance], timeout=15)
            raw = result.stdout + ("\n" + result.stderr if result.stderr else "")
            return [clean(line) for line in raw.splitlines() if line.strip()]
        path = next((Path(item["id"]) for item in self.file_instances() if item["name"] == instance), None)
        if path and path.is_file():
            return [clean(line) for line in path.read_text(errors="replace").splitlines()[-self.tail:] if line.strip()]
        raise ValueError("unknown instance")

    def metrics_url_for(self, instance: str, record: dict[str, Any] | None = None) -> str:
        configured = os.getenv(f"VLLM_OBSERVER_METRICS_URL_{re.sub(r'[^A-Za-z0-9]', '_', instance).upper()}", "").strip()
        if configured:
            return configured
        if self.metrics_url:
            return self.metrics_url
        record = record or next((item for item in self.docker_instances() if item["name"] == instance), None)
        if not record or not record.get("running"):
            return ""
        env = record.get("env", {})
        port = env.get("PORT") or env.get("VLLM_PORT")
        if not port:
            command = record.get("command", "")
            match = re.search(r"(?:^|\s)--port(?:=|\s+)(\d{1,5})(?:\s|$)", command)
            port = match.group(1) if match else ""
        try:
            port_number = int(port)
        except (TypeError, ValueError):
            return ""
        if not 1 <= port_number <= 65535:
            return ""
        return f"http://{self.metrics_host}:{port_number}/metrics"

    def expected_model_for(self, instance: str, record: dict[str, Any] | None = None) -> str:
        record = record or next((item for item in self.docker_instances() if item["name"] == instance), None)
        if not record:
            return ""
        env = record.get("env", {})
        return env.get("SERVED_MODEL_NAME") or Path(env.get("MODEL", "")).name

    def compose_template(self, instance: str) -> str:
        """Build a best-effort, editable Compose recreation of a discovered container."""
        record = next((item for item in self.docker_instances() if item["name"] == instance), None)
        if not record:
            raise ValueError("choose a discovered Docker instance")

        def quote(value: Any) -> str:
            return json.dumps(str(value), ensure_ascii=True)

        lines = ["services:", f"  {re.sub(r'[^a-zA-Z0-9_-]', '-', record['name'])}:", f"    image: {quote(record['image'])}"]
        if record.get("command_parts"):
            lines.append("    command:")
            lines.extend(f"      - {quote(part)}" for part in record["command_parts"])
        if record.get("env"):
            lines.append("    environment:")
            lines.extend(f"      {key}: {quote(value)}" for key, value in record["env"].items())
        if record.get("network_mode") == "host":
            lines.append("    network_mode: host")
        elif record.get("ports"):
            lines.append("    ports:")
            for container_port, bindings in record["ports"].items():
                if bindings:
                    for binding in bindings:
                        host_port = binding.get("HostPort")
                        lines.append(f"      - {quote(f'{host_port}:{container_port.split('/')[0]}')}")
        if record.get("ipc_mode"):
            lines.append(f"    ipc: {quote(record['ipc_mode'])}")
        if record.get("shm_size"):
            lines.append(f"    shm_size: {record['shm_size']}")
        if record.get("device_requests"):
            lines.append("    gpus: all")
        if record.get("mounts"):
            lines.append("    volumes:")
            for mount in record["mounts"]:
                mount_value = f"{mount['source']}:{mount['destination']}:{mount['mode']}"
                lines.append(f"      - {quote(mount_value)}")
        if record.get("restart_policy"):
            lines.append(f"    restart: {quote(record['restart_policy'])}")
        lines.extend([
            "",
            "# Generated from Docker inspect by vLLM Observer.",
            "# Review host paths, GPU access, secrets, and runtime-specific flags before starting.",
            "# The original container may depend on host drivers, shared memory, devices, or external files not represented here.",
        ])
        return "\n".join(lines) + "\n"
