# vLLM Observer

Drop-in, read-only observability for vLLM workloads. It discovers vLLM-like Docker containers, local log files, and mounted log directories, then presents live throughput, queue, KV-cache, LMCache, speculative decoding, and cache-transfer telemetry.

The project has no runtime dependencies beyond Python 3.11+. The dashboard is static and the collector uses only the Python standard library.

## Fastest Docker install

```bash
docker run -d --name vllm-observer \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -p 8088:8088 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  ghcr.io/yourname/vllm-observer:latest
```

Open `http://localhost:8088`.

Use **Minimal view** for a white, console-like layout with the most important values first. **Build Compose** downloads a ready-to-edit Compose file for the Docker deployment.

The Docker socket is optional but required for automatic container discovery. Docker grants broad authority to any process with socket access, even when the mount is marked read-only. For stricter isolation, disable Docker discovery and mount only log directories:

```bash
docker run -d --name vllm-observer \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  -e VLLM_OBSERVER_DOCKER=0 \
  -e VLLM_OBSERVER_LOG_PATHS=/logs \
  -v /path/to/vllm/logs:/logs:ro \
  -p 8088:8088 \
  ghcr.io/yourname/vllm-observer:latest
```

## Compose

Copy `compose/docker-compose.yml` beside your existing vLLM Compose file, adjust the log mount, and run:

```bash
docker compose up -d vllm-observer
```

The Compose example does not assume a container name. Discovery uses image, command, environment, labels, and service names containing `vllm`, `lmcache`, `sglang`, `triton`, or common model-serving terms. Set `VLLM_OBSERVER_CONTAINER_ALLOWLIST` when you want exact control.

## Host install

```bash
python3 -m observer.server
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VLLM_OBSERVER_PORT` | `8088` | HTTP listen port |
| `VLLM_OBSERVER_HOST` | `0.0.0.0` | Listen address |
| `VLLM_OBSERVER_DOCKER` | `1` | Discover Docker containers with the Docker CLI |
| `VLLM_OBSERVER_LOG_PATHS` | empty | Comma-separated files/directories to read |
| `VLLM_OBSERVER_CONTAINER_ALLOWLIST` | empty | Comma-separated exact container names |
| `VLLM_OBSERVER_LOG_TAIL` | `320` | Maximum lines per container/file |
| `VLLM_OBSERVER_REFRESH_SECONDS` | `3` | Dashboard polling interval |

## Safety model

The observer is deliberately boring:

- no Docker commands that create, stop, delete, exec into, or modify containers;
- no shell execution based on log content;
- no writes to discovered paths;
- bounded subprocess timeouts and log sizes;
- sensitive environment values and common bearer/token/password patterns are redacted;
- the observer excludes its own container by name and image;
- filesystem discovery is opt-in, bounded to configured paths, and read-only;
- absent metrics are shown as `not reported`, never fabricated.

This is an observer, not a security boundary. Protect the dashboard with a reverse proxy, firewall, VPN, or authentication before exposing it beyond a trusted network.

## Current scope

The parser recognizes common vLLM logger output plus LMCache, speculative decoding/MTP, CKV/cache-transfer, request queue, and prefix-cache lines. Native Prometheus support is planned as a higher-fidelity source than log parsing.

## Development

```bash
python3 -m unittest discover -s tests -v
python3 -m observer.server
```

Then visit `http://127.0.0.1:8088`.
