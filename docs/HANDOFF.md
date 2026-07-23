# vLLM Observer Maintainer Handoff

Use this document to start a new LLM on the repository without reconstructing the prior conversation.

## Current State

- Repository: `https://github.com/FujitsuPolycom/vllm-observer`
- Local path: `C:\Users\Cody\Documents\Github\vllm-observer`
- Branch: `master`
- `master` and `origin/master` are current together at the latest commit.
- Current commit: `5690274 fix: keep chart tooltip clear of cursor`
- AI01 deployment: `/opt/vllm-observer`, `http://192.168.0.213:8088/`
- AI01 is a LAN-only host at `192.168.0.213`; Tailscale is not installed on AI01 itself. A laptop Tailscale subnet route can capture the `192.168.0.0/24` route and make this LAN URL unreachable.
- The Compose listener is explicitly `0.0.0.0:8088`; Docker publishes port `8088` on all host interfaces.
- Runtime requires Python 3.11+ and has no third-party Python dependencies.
- Prometheus is the only performance source. Logger lines are displayed separately and are not throughput fallbacks.

## Start Here

Read these files first:

1. `docs/AGENT_GUIDE.md` for the compact LLM/coding-agent startup guide.
2. `README.md` for Docker, mounted-log, native Python, API, and configuration instructions.
3. `docs/FUTURE_IMPROVEMENTS.md` for the deep-dive resilience, security, topology, and model-friendliness review.
4. `observer/collector.py` for discovery, log collection, redaction, endpoint resolution, and Compose draft generation.
5. `observer/prometheus.py` for parsing, model identity checks, counter deltas, and normalized telemetry.
6. `observer/sampler.py` for background sampling, persistence, retention, reports, and log archiving.
7. `observer/server.py` for the HTTP API and static dashboard server.
8. `dashboard/js/app.js` and `dashboard/js/chart.js` for polling, chart state, interpolation, crosshair, point selection, and reports.
9. `docs/screenshots/` for current dashboard examples included in the README.

## Local Verification

From PowerShell:

```powershell
Set-Location C:\Users\Cody\Documents\Github\vllm-observer
python -m unittest discover -s tests -v
Get-ChildItem dashboard\js\*.js | ForEach-Object { node --check $_.FullName }
docker compose -f compose\docker-compose.yml config
docker compose -f docker\docker-compose.files.yml config
git diff --check
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
- Performance metrics are Prometheus-only. Logger lines are context and never a throughput fallback.
- Request Analytics uses Prometheus counters and histograms for TTFT, end-to-end latency, inter-token latency, prompt/output sizes, queue/prefill/decode time, totals, preemptions, uptime, and speculative decoding when exposed.
- Request Analytics is collapsible and has a separate long-term cache: one snapshot per minute by default, seven days by default, persisted in `/data/analytics-history.json`, and exposed at `/api/v1/instances/{name}/analytics`.
- Metric history is bounded and persisted. Logs are deduplicated by newly seen lines, then trimmed by age and byte cap.
- Charts support drag/drop, arrow reordering, expansion, light/dark mode, minimal/rich mode, model labels, series toggles, crosshair hover values, synchronized hover, cursor-aware tooltip placement, click-to-log pinning, and HTML report export.
- `Bridge gaps` is enabled by default for connected interpolated lines; turning it off breaks lines across long sample gaps. Scheduler charts remain discrete.
- The Live performance heading shows dynamic model/TP/DCP/MTP/GPU/context/dtype/runtime details from inspected environment variables or common launch flags. Values are not hardcoded to AI01 or GLM.
- Generated Compose output is a best-effort migration draft. Review paths, secrets, GPU/runtime settings, and external dependencies before starting it.

## Retention Defaults

- Real telemetry: 3,600 samples per workload, normally about one hour at one-second cadence, in `/data/history.json`.
- Request Analytics: one snapshot every 60 seconds, seven days, 10,081 points per workload, in `/data/analytics-history.json`.
- Logs: captured every three seconds, up to seven days and 50 MB, in `/data/log-history.json`.
- Point-selected log context: plus/minus 30 seconds, maximum 1,000 lines.

Relevant variables are `VLLM_OBSERVER_ANALYTICS_SAMPLE_SECONDS`, `VLLM_OBSERVER_ANALYTICS_HISTORY_SECONDS`, `VLLM_OBSERVER_HISTORY_POINTS`, `VLLM_OBSERVER_LOG_HISTORY_SECONDS`, and `VLLM_OBSERVER_LOG_HISTORY_MAX_BYTES`.

## Next Priorities

Read `docs/FUTURE_IMPROVEMENTS.md` before implementing changes. Highest priority:

1. Add authentication or provide a hardened reverse-proxy deployment and tighten CORS.
2. Add typed configuration validation and source-connectivity diagnostics.
3. Make collection resilient at scale with bounded concurrency/per-instance schedules, timeout/backoff, and missed-sample status.
4. Improve persistence with schema versioning/recovery and incremental file tailing.
5. Add topology adapters or explicit targets for Kubernetes, Podman, remote Docker, and non-container vLLM.
6. Expand metric aliases, identity policy, counter-reset handling, provenance, and confidence fields.
7. Add API contract tests and Playwright browser tests.

The long-term analytics API exists, but a dedicated historical Request Analytics chart/view is still future work.

## Guardrails

- Inspect `git status` before editing; preserve unrelated user changes.
- Keep the read-only safety boundary.
- Keep Prometheus as the only performance source.
- Run unit tests, syntax checks, Compose validation, and `git diff --check` before committing.
- Deploy AI01 only after the local checks pass; rebuild from the pushed `master` commit.

## Copy/Paste Startup Prompt

```text
You are taking over C:\Users\Cody\Documents\Github\vllm-observer. Read docs/AGENT_GUIDE.md, README.md, docs/HANDOFF.md, and docs/FUTURE_IMPROVEMENTS.md. Inspect git status and git log, then run the existing unit tests, JavaScript syntax checks, both Compose config validations, and git diff --check. Do not change code yet. Report the current architecture, deployment assumptions, retention behavior, highest-risk findings, and a small implementation plan for the next priority. Keep Prometheus as the only performance source, preserve the read-only safety boundary, and do not replace unrelated user or bot changes.
```
