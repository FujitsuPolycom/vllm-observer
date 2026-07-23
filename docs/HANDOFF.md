# vLLM Observer Maintainer Handoff

Use this document to start a new LLM on the repository without reconstructing the prior conversation.

## Current State

- Repository: `https://github.com/FujitsuPolycom/vllm-observer`
- Local path: `C:\Users\Cody\Documents\Github\vllm-observer`
- Branch: `master`
- `master` and `origin/master` are current together at the latest commit.
- AI01 deployment: `/opt/vllm-observer`, `http://192.168.0.213:8088/`
- Runtime requires Python 3.11+ and has no third-party Python dependencies.
- Prometheus is the only performance source. Logger lines are displayed separately and are not throughput fallbacks.

## Start Here

Read these files first:

1. `README.md` for Docker, mounted-log, native Python, API, and configuration instructions.
2. `docs/FUTURE_IMPROVEMENTS.md` for the deep-dive resilience, security, topology, and model-friendliness review.
3. `observer/collector.py` for discovery, log collection, redaction, endpoint resolution, and Compose draft generation.
4. `observer/prometheus.py` for parsing, model identity checks, counter deltas, and normalized telemetry.
5. `observer/sampler.py` for background sampling, persistence, retention, reports, and log archiving.
6. `observer/server.py` for the HTTP API and static dashboard server.
7. `dashboard/js/app.js` and `dashboard/js/chart.js` for polling, chart state, interpolation, crosshair, point selection, and reports.

## Local Verification

From PowerShell:

```powershell
Set-Location C:\Users\Cody\Documents\Github\vllm-observer
python -m unittest discover -s tests -v
Get-ChildItem dashboard\js\*.js | ForEach-Object { node --check $_.FullName }
docker compose -f compose\docker-compose.yml config
docker compose -f docker\docker-compose.files.yml config
```

To run directly:

```powershell
python -m venv .venv
. .venv\Scripts\Activate.ps1
python -m pip install -e .
$env:VLLM_OBSERVER_DOCKER = "0"
$env:VLLM_OBSERVER_METRICS_URL = "http://127.0.0.1:8000/metrics"
python -m observer.server
```

Open `http://127.0.0.1:8088/`.

## Deployment Modes

- `compose/docker-compose.yml`: observer and vLLM share a Docker host. Uses read-only Docker socket discovery, host-published metrics, durable named history volume, and seven-day/capped log retention.
- `docker/docker-compose.files.yml`: Docker discovery disabled. Mount selected files under `docker/logs`, set `VLLM_OBSERVER_METRICS_URL`, and use the explicit endpoint plus mounted logs.
- Native Python: use `VLLM_OBSERVER_DOCKER=0` and an explicit metrics URL. The endpoint must be reachable from the process running the observer.

Do not expose the current service directly to the public internet. It currently exposes operational details without built-in authentication and allows permissive CORS.

## Product Behavior

- Real samples are collected on a server-owned background clock.
- Virtual sampling only interpolates visually between real Prometheus samples.
- The UI shows real sampling cadence separately from virtual sampling rate.
- Charts support drag/drop, arrow reordering, expansion, crosshair toggle, hover values, click-to-log selection, and HTML report export.
- Metric history is bounded and persisted. Logs are deduplicated by newly seen lines, then trimmed by age and byte cap.
- Generated Compose output is a best-effort migration draft. Review paths, secrets, GPU/runtime settings, and external dependencies before starting it.

## Next Priorities

Read `docs/FUTURE_IMPROVEMENTS.md` before implementing changes. Highest priority:

1. Add authentication or provide a hardened reverse-proxy deployment and tighten CORS.
2. Add typed configuration validation and source-connectivity diagnostics.
3. Make collection resilient at scale with bounded concurrency/per-instance schedules, timeout/backoff, and missed-sample status.
4. Improve persistence with schema versioning/recovery and incremental file tailing.
5. Add topology adapters or explicit targets for Kubernetes, Podman, remote Docker, and non-container vLLM.
6. Expand metric aliases, identity policy, counter-reset handling, provenance, and confidence fields.
7. Add API contract tests and Playwright browser tests.

## Guardrails

- Inspect `git status` before editing; preserve unrelated user changes.
- Keep the read-only safety boundary.
- Keep Prometheus as the only performance source.
- Run unit tests, syntax checks, Compose validation, and `git diff --check` before committing.
- Deploy AI01 only after the local checks pass; rebuild from the pushed `master` commit.

## Copy/Paste Startup Prompt

```text
You are taking over C:\Users\Cody\Documents\Github\vllm-observer. Read README.md, docs/HANDOFF.md, and docs/FUTURE_IMPROVEMENTS.md. Inspect git status and git log, then run the existing unit tests, JavaScript syntax checks, and both Compose config validations. Do not change code yet. Report the current architecture, deployment assumptions, highest-risk findings, and a small implementation plan for the next priority. Keep Prometheus as the only performance source and preserve the read-only safety boundary.
```
