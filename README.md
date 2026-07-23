# vLLM Observer

Read-only observability for vLLM workloads. It discovers Docker containers, samples each workload's Prometheus endpoint on a server-owned clock, stores bounded rolling history, and displays throughput, cache, LMCache, MTP, scheduler, configuration, and logs.

Click any chart point to pin that time across the timeline, inspect the matching archived logs and runtime configuration, and export an HTML report with the selected telemetry and surrounding context.

The runtime requires Python 3.11 or newer and has no third-party Python dependencies. The dashboard uses native ES modules and HTML5 canvas.

## Docker Compose

```bash
git clone https://github.com/FujitsuPolycom/vllm-observer.git
cd vllm-observer
docker compose -f compose/docker-compose.yml up -d --build
```

Open `http://localhost:8088`.

The included Compose file:

- mounts the Docker socket for read-only discovery and log inspection;
- reaches host-published vLLM ports through `host.docker.internal`;
- retains 3,600 real samples per workload in a Docker volume;
- samples Prometheus every second independently of browsers and API clients.

Docker socket access is powerful even when mounted read-only. Protect the observer with a firewall, VPN, authentication proxy, or private network.

### Choose the deployment mode

Use `compose/docker-compose.yml` when the observer and vLLM run on the same Docker host. It discovers running and stopped vLLM-like containers, reads Docker logs, and resolves a metrics port from `PORT`, `VLLM_PORT`, or `--port`.

Use `docker/docker-compose.files.yml` when Docker discovery is unavailable or you only want to expose selected log files. Create the local log directory, put the files in it, and provide a metrics URL that is reachable **from inside the observer container**:

```bash
mkdir -p docker/logs
VLLM_OBSERVER_METRICS_URL=http://host.docker.internal:8000/metrics \
  docker compose -f docker/docker-compose.files.yml up -d --build
```

On Windows PowerShell, use `New-Item -ItemType Directory docker\logs` before starting Compose.

For a Linux host, replace `host.docker.internal` with a reachable host address or add an equivalent host-gateway mapping. The mounted-log example does not discover containers; it observes the configured files and the one explicit metrics endpoint.

To run directly on a host without Docker Compose (Bash):

```bash
python -m venv .venv
. .venv/bin/activate                 # Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -e .
VLLM_OBSERVER_DOCKER=0 \
VLLM_OBSERVER_METRICS_URL=http://127.0.0.1:8000/metrics \
  python -m observer.server
```

PowerShell equivalent:

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
python -m pip install -e .
$env:VLLM_OBSERVER_DOCKER = "0"
$env:VLLM_OBSERVER_METRICS_URL = "http://127.0.0.1:8000/metrics"
python -m observer.server
```

The observer is read-only, but it still needs network access to the metrics endpoint and, for Docker discovery, access to the Docker socket. Confirm the endpoint from the observer's network namespace before troubleshooting the dashboard:

```bash
docker compose exec vllm-observer python -c "from urllib.request import urlopen; print(urlopen('http://host.docker.internal:8000/metrics', timeout=3).status)"
```

## Metric endpoint resolution

For each running container, the observer reads `PORT`, `VLLM_PORT`, or `--port` and requests:

```text
http://<VLLM_OBSERVER_METRICS_HOST>:<port>/metrics
```

It compares Prometheus `model_name` labels with `SERVED_MODEL_NAME`. A mismatch is reported as `identity_mismatch`; metrics from the wrong model are never charted.

Use an explicit URL when automatic resolution is not possible:

```bash
VLLM_OBSERVER_METRICS_URL=http://model-host:8000/metrics
```

Use a per-container URL when observing several endpoints. Replace punctuation in the container name with underscores and uppercase it:

```bash
VLLM_OBSERVER_METRICS_URL_MY_VLLM=http://model-host:8000/metrics
```

## HTTP API

The container exposes a versioned, read-only JSON API on port `8088`.

| Endpoint | Purpose |
| --- | --- |
| `/api/v1` | API discovery document |
| `/api/v1/status` | Sampler cadence, persistence, and source status |
| `/api/v1/instances` | Discovered containers and runtime configuration |
| `/api/v1/instances/{name}/snapshot` | Latest verified telemetry point |
| `/api/v1/instances/{name}/history?limit=900` | Rolling real-sample history |
| `/api/v1/instances/{name}/logs` | Classified bounded log tail |
| `/api/v1/instances/{name}/logs?at=<timestamp>` | Archived log context around a chart point |
| `/api/v1/instances/{name}/report?at=<timestamp>` | Downloadable HTML report for a chart point |
| `/api/v1/instances/{name}/config` | Selected container details |

API reads never trigger metric collection. One background sampler owns counter state, so multiple dashboards and API clients cannot alter the measured interval.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VLLM_OBSERVER_PORT` | `8088` | HTTP listen port |
| `VLLM_OBSERVER_HOST` | `0.0.0.0` | HTTP listen address |
| `VLLM_OBSERVER_DOCKER` | `1` | Enable Docker discovery |
| `VLLM_OBSERVER_LOG_PATHS` | empty | Comma-separated files or directories |
| `VLLM_OBSERVER_CONTAINER_ALLOWLIST` | empty | Exact container names to include |
| `VLLM_OBSERVER_DISCOVERY_TERMS` | built-in terms | Comma-separated extra/replacement terms matched against container names, images, commands, and label keys |
| `VLLM_OBSERVER_LOG_TAIL` | `320` | Maximum lines returned per workload |
| `VLLM_OBSERVER_LOG_SAMPLE_SECONDS` | `3` | Interval for capturing new log lines into the archive |
| `VLLM_OBSERVER_LOG_HISTORY_SECONDS` | `604800` | Maximum log archive age; default is seven days |
| `VLLM_OBSERVER_LOG_CONTEXT_SECONDS` | `30` | Log archive window returned around a selected chart point |
| `VLLM_OBSERVER_LOG_CONTEXT_LINES` | `1000` | Maximum lines returned for selected log context |
| `VLLM_OBSERVER_LOG_HISTORY_MAX_BYTES` | `50000000` | Maximum persisted log archive size |
| `VLLM_OBSERVER_METRICS_HOST` | `127.0.0.1` | Host used with an auto-discovered port |
| `VLLM_OBSERVER_METRICS_URL` | empty | Explicit single-endpoint Prometheus URL |
| `VLLM_OBSERVER_METRICS_URL_<INSTANCE>` | empty | Per-container Prometheus URL |
| `VLLM_OBSERVER_SAMPLE_SECONDS` | `1` | Real server-side sample cadence |
| `VLLM_OBSERVER_HISTORY_POINTS` | `3600` | Samples retained per workload |
| `VLLM_OBSERVER_DATA_DIR` | empty | Directory for durable rolling history |

The default Compose deployment sets `VLLM_OBSERVER_DATA_DIR=/data` on a named volume. The log archive is deduplicated by newly seen lines, capped at 50 MB by default, and trimmed to seven days. A high-volume logger may reach the byte cap before seven days.

## Metrics

The Prometheus sampler calculates:

- fresh prefill, local prefix-cache reuse, external KV transfer, total cached ingest, and decode tokens per second;
- KV-cache occupancy, local prefix hit rate, and external prefix hit rate;
- MTP draft rate, accepted token rate, and acceptance percentage;
- running, waiting, and completed requests.

Logger output is displayed separately and is never used as a performance fallback. Chart interpolation only adds visual points between real server samples; the real points remain visible.

## Development

```bash
python -m unittest discover -s tests -v
python -m observer.server
```

Then open `http://127.0.0.1:8088`.

## Maintainer review

The current deep-dive findings are tracked in [`docs/FUTURE_IMPROVEMENTS.md`](docs/FUTURE_IMPROVEMENTS.md). They cover access control, resilience, topology adapters, model/metric variation, persistence, and automated verification work that is intentionally outside the current release scope.
