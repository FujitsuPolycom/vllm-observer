import { formatTime } from './time.js';

const element = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(
  /[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
);

const metricDefinitions = [
  ['throughput.fresh_prefill_tps', 'Fresh prefill', 'tok/s', 'New context computed by the model'],
  ['throughput.cached_local_tps', 'Local cache', 'tok/s', 'Local prefix-cache reuse'],
  ['throughput.external_cache_tps', 'External / LMCache', 'tok/s', 'Context loaded through external KV transfer'],
  ['throughput.decode_tps', 'Decode', 'tok/s', 'Generated output tokens'],
  ['cache.kv_usage_percent', 'KV cache used', '%', 'Current device KV occupancy'],
  ['cache.prefix_hit_percent', 'Prefix hit', '%', 'Cached tokens divided by queried tokens'],
  ['requests.running', 'Running', '', 'Requests in execution batches'],
  ['requests.waiting', 'Queued', '', 'Requests waiting for capacity'],
  ['speculative.acceptance_percent', 'MTP acceptance', '%', 'Accepted draft tokens'],
];

const capabilityDefinitions = [
  ['prompt_source_breakdown', 'Prompt source breakdown', 'Separates fresh compute, local cache, and external KV transfer.'],
  ['external_cache', 'External cache / LMCache', 'Reports external prefix queries or transferred prompt tokens.'],
  ['prefix_cache', 'Prefix cache', 'Reports prefix-cache query and hit counters.'],
  ['speculative_decoding', 'MTP / speculative decoding', 'Reports drafted and accepted token counters.'],
];

export function renderInstances(instances, selected) {
  const running = instances.filter(item => item.running);
  const stopped = instances.filter(item => !item.running);
  const rows = [...running, ...stopped];
  element('instanceSelect').innerHTML = rows.length
    ? rows.map(item => `<option value="${escapeHtml(item.name)}">${item.running ? 'LIVE' : 'STOP'} · ${escapeHtml(item.name)}</option>`).join('')
    : '<option value="">No vLLM workloads found</option>';
  element('instanceSelect').value = selected;
}

export function renderSnapshot(point) {
  const source = point.source || {};
  element('sourceUrl').textContent = source.url || 'Not resolved';
  element('sourceUrl').title = source.url || '';
  element('sourceModel').textContent = source.observed_models?.join(', ') || source.expected_model || 'Waiting';
  document.querySelectorAll('.chart-model').forEach(node => {
    node.textContent = source.observed_models?.join(', ') || source.expected_model || 'model pending';
  });
 element('sampleCadence').textContent = point.sample_seconds ? `${point.sample_seconds.toFixed(2)} s` : 'Waiting';
  element('realSamplingRate').textContent = point.sample_seconds ? `${point.sample_seconds.toFixed(2)} s` : 'Waiting';
  element('lastCollected').textContent = point.timestamp ? formatTime(point.timestamp, true) : 'Waiting';

  const diagnostic = element('diagnostic');
  diagnostic.className = `diagnostic source-status ${point.status || 'waiting'}`;
  if (point.status === 'ok') {
    diagnostic.innerHTML = `<strong>Source verified.</strong> ${escapeHtml(source.expected_model || 'Selected workload')} matches ${escapeHtml(source.observed_models?.join(', ') || 'the endpoint')}. Charts contain only server-sampled Prometheus data.`;
  } else {
    diagnostic.innerHTML = `<strong>${escapeHtml(statusTitle(point.status))}.</strong> ${escapeHtml(point.error || 'No telemetry is available yet.')}`;
  }

  const cards = metricDefinitions.map(([path, label, unit, note]) => {
    const value = get(point, path);
    const available = Number.isFinite(Number(value));
    return `<article class="metric-card ${available ? '' : 'unavailable'}">
      <span>${escapeHtml(label)}</span>
      <strong>${available ? `${format(value)}${unit ? ` <small>${unit}</small>` : ''}` : '—'}</strong>
      <p>${escapeHtml(available ? note : 'Not exposed by this endpoint yet')}</p>
    </article>`;
  });
  element('metricCards').innerHTML = cards.join('');
  renderRequestAnalytics(point);

  const capabilities = point.capabilities || {};
  element('capabilities').innerHTML = capabilityDefinitions.map(([key, label, description]) => `
    <article class="capability">
      <span class="capability-state ${capabilities[key] ? 'available' : 'absent'}">${capabilities[key] ? 'AVAILABLE' : 'NOT EXPOSED'}</span>
      <h3>${escapeHtml(label)}</h3>
      <p>${escapeHtml(description)}</p>
    </article>`).join('');
}

export function renderConfiguration(item) {
  if (!item) {
    element('configuration').innerHTML = '<div class="empty">No container selected.</div>';
    return;
  }
  const environment = item.env || {};
  const definitions = [
    ['Model', key => ['MODEL', 'MODEL_FAMILY', 'SERVED_MODEL_NAME', 'QUANTIZATION', 'LOAD_FORMAT', 'MOE_MODE'].includes(key)],
    ['Serving', key => key === 'PORT' || key === 'GRAPH' || key.startsWith('MAX_')],
    ['KV cache and LMCache', key => key.startsWith('KV_') || key.startsWith('LMCACHE_')],
    ['Parallelism and MTP', key => ['TP', 'DCP', 'MTP', 'GPUS'].includes(key) || key.startsWith('VLLM_DCP_')],
    ['vLLM tuning', key => key.startsWith('VLLM_')],
    ['CUDA and NCCL', key => key.startsWith('CUDA_') || key.startsWith('NCCL_')],
  ];
  const used = new Set();
  const groups = definitions.map(([title, predicate]) => {
    const keys = Object.keys(environment).filter(key => !used.has(key) && predicate(key));
    keys.forEach(key => used.add(key));
    return [title, keys];
  }).filter(([, keys]) => keys.length);
  const other = Object.keys(environment).filter(key => !used.has(key));
  if (other.length) groups.push(['Other', other]);

  const row = (key, value) => `<div class="config-row"><span>${escapeHtml(key)}</span><code>${escapeHtml(value)}</code></div>`;
  const identity = [
    ['Image', item.image],
    ['Command', item.command || 'default'],
    ['Status', item.status],
    ['Network', item.network_mode || 'default'],
    ['PID', item.pid ?? 'n/a'],
  ];
  element('configuration').innerHTML = `
    <details class="config-group" open>
      <summary><span>Container</span><small>${identity.length} values</small></summary>
      <div>${identity.map(([key, value]) => row(key, value)).join('')}</div>
    </details>
    ${groups.map(([title, keys]) => `
      <details class="config-group">
        <summary><span>${escapeHtml(title)}</span><small>${keys.length} flags · expand</small></summary>
        <div>${keys.map(key => row(key, environment[key])).join('')}</div>
      </details>`).join('')}`;
  element('configMeta').textContent = `${Object.keys(environment).length} runtime flags`;
}

export function renderLogs(payload) {
  const groups = payload.groups || {};
  const focusLine = payload.focus_line;
  const definitions = [
    ['lmcache', 'LMCache / KV transfer'],
    ['prefill', 'Prefill / prompt'],
    ['decode', 'Decode / engine'],
    ['requests', 'Requests / serving'],
    ['other', 'Startup / other'],
  ];
  const open = new Set([...element('logs').querySelectorAll('details[open]')].map(node => node.dataset.group));
  element('logs').innerHTML = definitions.map(([key, label]) => {
    const lines = groups[key] || [];
    return `<details class="log-group" data-group="${key}" ${open.has(key) ? 'open' : ''}>
      <summary><span>${escapeHtml(label)}</span><small>${lines.length} lines · expand</small></summary>
      <div class="log-lines">${lines.length ? lines.map(line => `<div>${escapeHtml(line)}</div>`).join('') : '<p class="empty">No matching lines.</p>'}</div>
    </details>`;
  }).join('');
  element('logMeta').textContent = `${payload.lines?.length || 0} lines`;
  if (focusLine) {
    const focusedLine = [...element('logs').querySelectorAll('.log-lines > div')]
      .find(line => line.textContent === focusLine);
    if (focusedLine) {
      focusedLine.classList.add('log-focus');
      focusedLine.closest('details').open = true;
      focusedLine.scrollIntoView({ block: 'center' });
    }
  }
}

function renderRequestAnalytics(point) {
  const analytics = point.request_analytics || {};
  const totals = analytics.totals || {};
  const metric = (path, scale = 1) => {
    const value = path.split('.').reduce((current, key) => current?.[key], analytics);
    return Number.isFinite(Number(value)) ? Number(value) * scale : null;
  };
  const display = (value, unit = '') => value === null ? 'not reported' : `${format(value)}${unit}`;
  const cards = [
    ['TTFT average', metric('time_to_first_token.average'), ' s'],
    ['TTFT p99', metric('time_to_first_token.p99'), ' s'],
    ['End-to-end p99', metric('end_to_end.p99'), ' s'],
    ['Inter-token average', metric('inter_token.average') === null ? null : metric('inter_token.average') * 1000, ' ms'],
    ['Prompt tokens', Number.isFinite(Number(totals.prompt_tokens)) ? Number(totals.prompt_tokens) : null, ''],
    ['Generation tokens', Number.isFinite(Number(totals.generation_tokens)) ? Number(totals.generation_tokens) : null, ''],
    ['Preemptions', Number.isFinite(Number(totals.preemptions)) ? Number(totals.preemptions) : null, ''],
    ['Uptime', metric('uptime_seconds') === null ? null : formatDuration(metric('uptime_seconds')), ''],
  ];
  const cardMarkup = cards.map(([label, value, unit]) => `<article class="request-card"><span>${escapeHtml(label)}</span><strong>${typeof value === 'string' ? value : display(value, unit)}</strong></article>`).join('');
  const anatomy = [
    ['Queue', metric('queue_time.average'), '#dcb7e2'],
    ['Prefill', metric('prefill_time.average'), '#a68be0'],
    ['Decode', metric('decode_time.average'), '#4169d8'],
  ].filter(([, value]) => value !== null);
  const totalTime = anatomy.reduce((sum, [, value]) => sum + value, 0);
  const anatomyMarkup = anatomy.length ? `<div class="request-anatomy"><div class="request-anatomy-bar">${anatomy.map(([label, value, color]) => `<span style="--series:${color}; flex:${value / totalTime}" title="${escapeHtml(label)} ${value.toFixed(2)} s">${escapeHtml(label)}</span>`).join('')}</div><div class="request-anatomy-legend">${anatomy.map(([label, value]) => `<span>${escapeHtml(label)} <b>${value.toFixed(2)} s</b></span>`).join('')}</div></div>` : '';
  const latency = [['Time to first token', analytics.time_to_first_token], ['End-to-end latency', analytics.end_to_end]].filter(([, value]) => value);
  const latencyMarkup = latency.length ? `<div class="request-latency-grid">${latency.map(([label, value]) => `<article><h3>${escapeHtml(label)}</h3>${['p50', 'p90', 'p95', 'p99'].map(key => `<div class="percentile-row"><span>${key}</span><i style="--size:${Math.min(100, (Number(value[key]) || 0) / (Number(value.p99) || 1) * 100)}%"></i><b>${value[key] == null ? 'n/a' : `${(Number(value[key]) * 1000).toFixed(0)} ms`}</b></div>`).join('')}</article>`).join('')}</div>` : '';
  const sizes = [['Prompt p50', metric('prompt_size.p50')], ['Output p50', metric('output_size.p50')], ['Spec. acceptance', analytics.speculative?.drafted_tokens ? `${((analytics.speculative.accepted_tokens || 0) / analytics.speculative.drafted_tokens * 100).toFixed(1)}%` : null]].filter(([, value]) => value !== null && value !== undefined);
  const sizeMarkup = sizes.length ? `<div class="request-small-grid">${sizes.map(([label, value]) => `<span>${escapeHtml(label)} <b>${typeof value === 'string' ? value : format(value) + ' tok'}</b></span>`).join('')}</div>` : '';
  element('requestAnalyticsBody').innerHTML = `<div class="request-card-grid">${cardMarkup}</div>${anatomyMarkup}${latencyMarkup}${sizeMarkup}`;
}

export function setConnection(status, text) {
  const connection = element('connection');
  connection.className = `connection ${status}`;
  connection.lastChild.textContent = text;
}

function get(object, path) {
  return path.split('.').reduce((value, key) => value?.[key], object);
}

function format(value) {
  const number = Number(value);
  if (number >= 1000000) return `${(number / 1000000).toFixed(2)}m`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
  return number >= 100 ? number.toFixed(0) : number.toFixed(1);
}

function formatDuration(seconds) {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}d ${Math.floor(seconds / 3600) % 24}h`;
}

function statusTitle(status) {
  return ({
    warming: 'Sampler warming up',
    unconfigured: 'Metrics endpoint unresolved',
    identity_mismatch: 'Wrong metrics endpoint',
    error: 'Metrics collection failed',
  })[status] || 'Telemetry unavailable';
}
