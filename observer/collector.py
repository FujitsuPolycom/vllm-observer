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
        prefixes = ("VLLM_", "LMCACHE_", "KV_", "MODEL", "SERVED_MODEL", "MAX_", "TP", "DCP", "MTP", "PORT", "QUANT", "MOE", "CUDA_", "NCCL_")
        selected = {}
        for entry in values or []:
            key, _, value = entry.partition("=")
            if not key.startswith(prefixes):
                continue
            if any(word in key.upper() for word in ("TOKEN", "PASSWORD", "SECRET", "API_KEY")):
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
            "status": state.get("Status", "unknown"),
            "running": bool(state.get("Running")),
            "started_at": state.get("StartedAt", ""),
            "finished_at": state.get("FinishedAt", ""),
            "exit_code": state.get("ExitCode"),
            "pid": state.get("Pid"),
            "network_mode": host.get("NetworkMode", ""),
            "restart_policy": (host.get("RestartPolicy") or {}).get("Name", ""),
            "env": self._env(config.get("Env")),
            "ports": network.get("Ports") or {},
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
