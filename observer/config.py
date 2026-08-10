"""Validated environment configuration and release metadata."""

from __future__ import annotations

import os
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version


class ConfigurationError(ValueError):
    """Raised when one or more environment settings are invalid."""


def env_int(name: str, default: int, minimum: int, maximum: int | None = None) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer; got {raw!r}") from error
    if value < minimum or (maximum is not None and value > maximum):
        upper = f" and <= {maximum}" if maximum is not None else ""
        raise ConfigurationError(f"{name} must be >= {minimum}{upper}; got {value}")
    return value


def env_float(name: str, default: float, minimum: float, maximum: float | None = None) -> float:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = float(raw)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number; got {raw!r}") from error
    if value < minimum or (maximum is not None and value > maximum):
        upper = f" and <= {maximum}" if maximum is not None else ""
        raise ConfigurationError(f"{name} must be >= {minimum}{upper}; got {value}")
    return value


def env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name, "1" if default else "0").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"{name} must be true or false; got {raw!r}")


@dataclass(frozen=True)
class ServerConfig:
    host: str
    port: int
    auth_token: str
    auth_username: str
    auth_password: str
    cors_origins: tuple[str, ...]

    @classmethod
    def from_env(cls) -> "ServerConfig":
        origins = tuple(x.strip() for x in os.getenv("VLLM_OBSERVER_CORS_ORIGINS", "").split(",") if x.strip())
        username = os.getenv("VLLM_OBSERVER_AUTH_USERNAME", "").strip()
        password = os.getenv("VLLM_OBSERVER_AUTH_PASSWORD", "")
        if bool(username) != bool(password):
            raise ConfigurationError("VLLM_OBSERVER_AUTH_USERNAME and VLLM_OBSERVER_AUTH_PASSWORD must be set together")
        return cls(
            host=os.getenv("VLLM_OBSERVER_HOST", "0.0.0.0").strip(),
            port=env_int("VLLM_OBSERVER_PORT", 8088, 1, 65535),
            auth_token=os.getenv("VLLM_OBSERVER_AUTH_TOKEN", "").strip(),
            auth_username=username,
            auth_password=password,
            cors_origins=origins,
        )


def build_info() -> dict[str, str]:
    try:
        release = version("vllm-observer")
    except PackageNotFoundError:
        release = "0.2.0"
    return {
        "version": release,
        "commit": os.getenv("VLLM_OBSERVER_BUILD_COMMIT", "unknown"),
        "built_at": os.getenv("VLLM_OBSERVER_BUILD_DATE", "unknown"),
    }
