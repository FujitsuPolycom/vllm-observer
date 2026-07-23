# Future Improvements

This is a maintainer review of vLLM Observer at `ac3920e`. These are findings and design directions, not claims that the current release is unusable. The current release is read-only and bounded, but it should be treated as a private-network tool until authentication and access controls exist.

## Priority 0: access control and secret handling

### No authentication or authorization

The HTTP server binds to `0.0.0.0` by default, enables `Access-Control-Allow-Origin: *`, and exposes container inventory, selected environment variables, command lines, mounts, logs, metrics URLs, Compose reconstruction, and downloadable reports. A read-only Docker socket prevents container mutation, but it does not make the information public-safe.

**Direction:** add an explicit unauthenticated-private mode, an authentication-proxy deployment, and optionally built-in bearer-token protection. Default CORS should be same-origin or disabled. Document a reverse-proxy example with TLS and an allowlist.

### URL and configuration secret leakage

Explicit metrics URLs and discovered runtime configuration can contain credentials or tokens in unusual environment-variable names, command arguments, or URL query strings. The current redaction is prefix- and key-name-based, so it cannot guarantee that every secret-shaped value is removed.

**Direction:** redact URL userinfo/query credentials, expand secret-key detection, avoid returning raw URLs in public-facing reports, and make `--expose-config` style behavior opt-in.

## Priority 1: resilience under real workloads

### Collection is serial and can drift with workload count

`MetricSampler.sample_all()` samples every workload serially. Each metrics request can wait up to three seconds, and Docker discovery/inspection can add more waits. With enough containers, the configured one-second cadence becomes impossible and every workload receives a delayed sample.

**Direction:** use a bounded worker pool or per-instance schedule, keep a per-instance timeout, record collection duration and missed samples, and expose scheduler health in `/api/v1/status`. Do not create unbounded threads per request.

### Discovery repeats expensive Docker operations

Inventory refresh runs Docker listing and individual `docker inspect` calls every ten seconds. A large host or a temporarily unhealthy Docker daemon can make discovery slow or noisy.

**Direction:** cache inspect results with a TTL, use one structured Docker API client or a single formatted inspect call, and apply exponential backoff after Docker failures.

### Persistence is safe-ish but not durable enough for hard failures

History files are rewritten periodically through a temporary file replacement, but there is no `fsync`, recovery journal, schema version, or separate corruption quarantine. The log archive's seen-line index is not persisted, so a restart can re-append the current Docker tail. The two JSON files can also become inconsistent after a crash.

**Direction:** version the on-disk schema, use a small append-only segment or SQLite/WAL store, checksum or validate records, and make retention/recovery observable. Persist a stable log cursor when the source supports one.

### File log collection reads whole files

Mounted-file mode calls `read_text()` on the complete file and then slices the final lines. A large or rapidly growing log can cause avoidable memory pressure and latency.

**Direction:** tail files by seeking from the end, enforce a byte budget before decoding, and track inode/offset so rotation and truncation are handled explicitly.

### Configuration parsing can terminate startup

Several numeric environment variables are converted directly with `int()` or `float()`. A typo in deployment configuration can crash the service instead of returning a clear validation error.

**Direction:** centralize typed configuration, validate ranges, report all invalid variables at startup, and fail with an actionable message.

## Priority 1: topology and deployment compatibility

### Docker socket discovery is host-local

The default Compose deployment only discovers containers visible through the mounted Docker socket. It does not discover Kubernetes pods, containerd workloads, Podman machines, remote Docker daemons, or vLLM processes running directly on another host.

**Direction:** keep the current Docker adapter, then add independent adapters for mounted logs, explicit targets, Kubernetes, and remote agents. The API should identify the topology and source capabilities instead of assuming every instance is a Docker container.

### Network reachability is not validated from the observer namespace

The auto-resolved metrics URL may be correct on the host but unreachable from the observer container, especially with bridge networking, rootless Docker, Proxmox guests, or remote vLLM nodes.

**Direction:** expose a per-instance connectivity diagnosis with resolved URL, DNS result, TCP/HTTP failure class, and last successful scrape. Offer explicit per-instance target configuration in a mounted YAML file or environment map.

### Compose reconstruction is best-effort, not reproducible

The generated Compose output omits or simplifies important Docker properties such as health checks, user, capabilities, ulimits, tmpfs, extra hosts, labels, runtime details, dependencies, stop behavior, and some device mappings. It also emits host paths and environment values that may not exist on the new machine.

**Direction:** label the output as a migration draft, include a completeness/warnings section, preserve more inspect fields, and generate a companion `.env.example` with secret placeholders rather than silently copying sensitive values.

## Priority 2: model and metric friendliness

### Metric naming and label shapes vary widely

Normalization currently expects a known set of vLLM-style metric names and source labels. Forks, older vLLM versions, custom LMCache builds, SGLang, and multi-engine deployments may expose equivalent data under different names or label dimensions.

**Direction:** add a metric capability registry with aliases, label selectors, units, counter/gauge type, and confidence. Show exactly which source metric produced each displayed value. Keep unknown metrics available through a raw, bounded diagnostics endpoint.

### Model identity matching is heuristic

The current fuzzy matching prevents obvious cross-model mistakes, but substring matching can accept ambiguous names and multi-model endpoints. A missing model label also weakens verification.

**Direction:** make identity policy explicit: strict, normalized exact, or unchecked. Require a selected label set for multi-model endpoints and report identity confidence rather than only `ok` or `identity_mismatch`.

### Counter resets and restarts need clearer semantics

Counter deltas can be invalidated by model restarts, replica changes, or exporter resets. The current normalized point can remain available, but users need to know when a rate was discarded or restarted.

**Direction:** detect resets per metric family, annotate points with reset/restart events, and reset rate windows without presenting a misleading zero as measured throughput.

### Cache time-saved estimates need measured overhead

Cached-token throughput can estimate avoided fresh-prefill compute, but it is not end-to-end latency savings. LMCache transfer, serialization, scheduling, and queueing overhead can dominate.

**Direction:** add separate fields for `gpu_prefill_time_avoided_estimate`, `cache_transfer_time`, `cache_overhead`, and `net_latency_saved_estimate`, with an explicit confidence level. Validate the estimate against completed-request prefill timing when those metrics exist.

## Priority 2: API and UI maintainability

### API contract and error taxonomy are implicit

The API has a discovery document, but it lacks schemas, pagination guarantees, retention semantics, and stable error codes. Some failures are returned as HTTP 503 while other invalid inputs are normalized or passed through.

**Direction:** publish JSON schemas or OpenAPI, define error codes, add API contract tests, and include source freshness/retention metadata in every history response.

### Browser state and live updates need broader testing

The UI now avoids full-page refreshes and supports chart ordering, interpolation, crosshairs, point selection, and reports. Those interactions need automated browser coverage across mobile, expanded charts, stale history, empty metrics, and a workload switch during an in-flight request.

**Direction:** add Playwright smoke tests and a deterministic fixture server. Test canvas dimensions, tooltip positioning, keyboard access, chart ordering persistence, and no-horizontal-overflow at narrow widths.

## Suggested sequence

1. Put the service behind an authentication boundary and tighten CORS.
2. Add typed configuration and source connectivity diagnostics.
3. Move persistence to a versioned WAL/SQLite design and tail files incrementally.
4. Split collection into topology adapters and bounded per-instance schedules.
5. Expand metric aliases/capabilities and expose provenance/confidence.
6. Add Compose migration warnings and browser/API contract tests.
