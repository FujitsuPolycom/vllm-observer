# vLLM Observer Agent Guide

This is the shortest reliable starting point for an LLM or coding agent working on this repository.

## Mission

vLLM Observer is a read-only dashboard for vLLM-like workloads. It discovers workloads, samples Prometheus metrics on a server-owned clock, keeps bounded history, classifies logs, and presents telemetry/configuration/log context in a browser.

The project is model-agnostic by design. Do not add GLM-specific assumptions unless they are isolated behind a generic model or metric adapter.

## First Read

Read these in order:

1. `README.md`: user setup, deployment modes, API, environment variables, and metric definitions.
2. `docs/HANDOFF.md`: current deployment, workflows, guardrails, and priority list.
3. `docs/FUTURE_IMPROVEMENTS.md`: known security, resilience, topology, persistence, and compatibility findings.
4. `observer/prometheus.py`: Prometheus parsing, model identity, counter deltas, and normalized telemetry.
5. `observer/sampler.py`: background collection, rolling history, log archive, retention, and reports.
6. `observer/collector.py`: Docker discovery, log reads, redaction, endpoint resolution, and Compose drafts.
7. `observer/server.py`: HTTP API and static file serving.
8. `dashboard/js/app.js` and `dashboard/js/chart.js`: polling, charts, interpolation, crosshairs, pinning, reports, and UI state.

## Non-Negotiable Behavior

- Prometheus is the only source for performance numbers.
- Logger output may be displayed for context, but must never be used as a throughput fallback.
- Virtual sampling is visual interpolation only. Preserve the real server samples and show the real cadence separately.
- Scheduler running/queued values are discrete gauges. Do not interpolate them into fractional requests.
- Collection and API reads must remain read-only. Never mutate, restart, stop, or exec into a discovered workload.
- Keep logs and metric history bounded. Do not introduce unbounded in-memory or on-disk retention.
- Preserve model identity checks. A metric endpoint that does not match the expected model must not be charted silently.
- Treat generated Compose as a reviewable draft, not a guaranteed reproduction of the original launch.
- Do not expose the default service directly to the public internet. Authentication is not built into the current service.

## Current User Experience

- The default timeline window is one minute.
- The history slider moves from older data on the left to the live edge on the right.
- The real sampling rate is shown below the virtual sampling-rate control.
- Charts support crosshair hover values, synchronized hover, expansion, drag/drop and arrow reordering.
- Clicking a chart point pins that timestamp without moving the page. The pinned banner offers an explicit `Go to logs` action; matching archived logs are highlighted after loading.
- A pinned point can export an HTML report containing selected telemetry, runtime/configuration details, and surrounding log context.
- Pause/resume stops live updates while preserving the current view.

## Data and Retention Defaults

The standard Compose deployment uses a named `/data` volume:

- Metrics: 3,600 real samples per workload, normally about one hour at one-second cadence.
- Logs: captured every three seconds, retained up to seven days and 50 MB by default.
- Log archive: deduplicated by newly seen lines and persisted at `/data/log-history.json`.
- Point context: 30 seconds around the selected timestamp, up to 1,000 lines.

These are configurable. The seven-day setting is an age ceiling; the byte limit can trim older data sooner.

## Local Checks

Run from the repository root in PowerShell:

```powershell
python -m unittest discover -s tests -v
Get-ChildItem dashboard\js\*.js | ForEach-Object { node --check $_.FullName }
docker compose -f compose\docker-compose.yml config
docker compose -f docker\docker-compose.files.yml config
git diff --check
```

Before editing, inspect `git status`. Preserve unrelated changes. Use `apply_patch` for manual edits. Keep changes scoped and add tests when behavior crosses an API, parser, sampler, or persistence boundary.

## Deployment

The public repository is:

```text
https://github.com/FujitsuPolycom/vllm-observer
```

AI01 deployment is `/opt/vllm-observer` at `http://192.168.0.213:8088/`. After local checks pass:

```powershell
git add <files>
git commit -m "<imperative change>"
git push origin master
ssh ai01 "cd /opt/vllm-observer && git fetch origin && git reset --hard origin/master && docker compose -f compose/docker-compose.yml up -d --build"
```

Do not deploy uncommitted work. Verify the service returns HTTP 200 after a rebuild.

## Useful API Surface

- `/api/v1`: discovery document
- `/api/v1/status`: sampler cadence, persistence, and source status
- `/api/v1/instances`: discovered workloads and runtime configuration
- `/api/v1/instances/{name}/snapshot`: latest verified point
- `/api/v1/instances/{name}/history?limit=900`: real rolling samples
- `/api/v1/instances/{name}/logs`: bounded classified log tail
- `/api/v1/instances/{name}/logs?at=<timestamp>`: archived context around a chart point
- `/api/v1/instances/{name}/report?at=<timestamp>`: downloadable point report
- `/api/v1/instances/{name}/config`: selected container details

API reads must not trigger a new metric sample. One background sampler owns counter state and cadence.

## When Reviewing or Extending

Check these questions before coding:

1. Is this behavior generic across models, runtimes, and metric label variants?
2. Does it preserve Prometheus-only performance provenance?
3. Does it keep real and derived values distinguishable?
4. What happens when the endpoint, container, log archive, model label, or persisted file is missing or malformed?
5. Is the memory, disk, network, and browser cost bounded?
6. Does it work on a narrow mobile viewport and with a paused historical view?
7. Are the API, parser, sampler, persistence, and browser states covered by an appropriate test?

For new risks or larger redesigns, update `docs/FUTURE_IMPROVEMENTS.md` rather than silently broadening the current release.

## Copy/Paste Prompt

```text
You are taking over the vLLM Observer repository. Read docs/AGENT_GUIDE.md, README.md, docs/HANDOFF.md, and docs/FUTURE_IMPROVEMENTS.md before changing anything. Inspect git status and git log. Preserve the read-only safety boundary, Prometheus-only performance metrics, discrete scheduler gauges, bounded retention, model identity checks, and model-agnostic behavior. Run the existing tests and syntax/Compose checks before and after changes. Keep the change scoped, commit it, push master, and only then redeploy AI01 if deployment is requested.
```
