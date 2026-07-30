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
  ['live_prefill_counter', 'Live scheduler prefill', 'Uses scheduler-issued fresh prompt tokens while chunked prefill is in progress.'],
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

  const schedulerPrefill = point.fresh_prefill_source === 'scheduler';
  const cards = metricDefinitions.map(([path, label, unit, note]) => {
    if (path === 'throughput.fresh_prefill_tps' && schedulerPrefill) {
      label = 'Fresh prefill (live)';
      note = 'Scheduler-issued fresh prompt work; updates during chunked prefill';
    }
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
    element('runtimeSummary').textContent = 'Runtime config unavailable';
    return;
  }
  const environment = item.env || {};
  const command = String(item.command || '');
  const value = (keys, flags = []) => {
    const fromEnvironment = keys.map(key => environment[key]).find(entry => entry !== undefined && entry !== '');
    if (fromEnvironment !== undefined) return fromEnvironment;
    for (const flag of flags) {
      const match = command.match(new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)([^\\s]+)`));
      if (match) return match[1].replace(/^['"]|['"]$/g, '');
    }
    return undefined;
  };
  const runtime = [
    ['MODEL', value(['SERVED_MODEL_NAME', 'MODEL', 'MODEL_NAME'], ['--served-model-name', '--model']) || item.image || 'unknown'],
    ['TP', value(['TP', 'TENSOR_PARALLEL_SIZE'], ['--tensor-parallel-size'])],
    ['DCP', value(['DCP', 'DATA_PARALLEL_SIZE'], ['--data-parallel-size', '--decode-context-parallel-size'])],
    ['MTP', value(['MTP', 'NUM_SPECULATIVE_TOKENS', 'SPECULATIVE_CONFIG'], ['--speculative-config', '--num-speculative-tokens', '--speculative-model'])],
    ['GPUs', value(['GPUS', 'GPU_COUNT', 'CUDA_VISIBLE_DEVICES'])],
    ['Context', value(['MAX_MODEL_LEN', 'MAX_SEQ_LEN', 'MAX_CONTEXT_LEN'], ['--max-model-len', '--max-seq-len-to-capture'])],
    ['Dtype', value(['DTYPE', 'TORCH_DTYPE', 'QUANTIZATION'], ['--dtype', '--quantization'])],
    ['GPU mem', value(['GPU_MEMORY_UTILIZATION'], ['--gpu-memory-utilization'])],
  ].filter(([, entry]) => entry !== undefined);
  element('runtimeSummary').innerHTML = runtime.map(([label, entry]) => `<span title="${escapeHtml(label)}">${escapeHtml(label)}: <b>${escapeHtml(entry)}</b></span>`).join('');
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
  const scrollState = new Map([...element('logs').querySelectorAll('.log-group')].map(group => {
    const lines = group.querySelector('.log-lines');
    if (!lines) return [group.dataset.group, null];
    return [group.dataset.group, {
      scrollTop: lines.scrollTop,
      followTail: lines.scrollHeight - lines.clientHeight - lines.scrollTop <= 24,
    }];
  }));
  const open = new Set([...element('logs').querySelectorAll('details[open]')].map(node => node.dataset.group));
  element('logs').innerHTML = definitions.map(([key, label]) => {
    const lines = groups[key] || [];
    return `<details class="log-group" data-group="${key}" ${open.has(key) ? 'open' : ''}>
      <summary><span>${escapeHtml(label)}</span><small>${lines.length} lines · expand</small></summary>
      <div class="log-lines">${lines.length ? lines.map(line => `<div>${escapeHtml(line)}</div>`).join('') : '<p class="empty">No matching lines.</p>'}</div>
    </details>`;
  }).join('');
  element('logMeta').textContent = `${payload.lines?.length || 0} lines`;
  const restoreLogView = () => {
    element('logs').querySelectorAll('.log-group').forEach(group => {
      const lines = group.querySelector('.log-lines');
      if (!lines) return;
      const previous = scrollState.get(group.dataset.group);
      if (!previous || previous.followTail) lines.scrollTop = lines.scrollHeight;
      else lines.scrollTop = previous.scrollTop;
    });
    if (focusLine) {
      const focusedLine = [...element('logs').querySelectorAll('.log-lines > div')]
        .find(line => line.textContent === focusLine);
      if (focusedLine) {
        focusedLine.classList.add('log-focus');
        focusedLine.closest('details').open = true;
        focusedLine.scrollIntoView({ block: 'center' });
      }
    }
  };
  requestAnimationFrame(restoreLogView);
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

export function renderModelDetails(point, config) {
  const grid = element('modelDetails');
  if (!grid) return;
  const env = config?.env || {};
  const command = String(config?.command || '');
  const runtime = point?.runtime_info || {};
  const source = point?.source || {};
  const models = source.observed_models || source.expected_model || [];

  const envVal = (keys, flags = []) => {
    const fromEnv = keys.map(k => env[k]).find(v => v !== undefined && v !== '');
    if (fromEnv !== undefined) return fromEnv;
    for (const flag of flags) {
      const match = command.match(new RegExp(`(?:^|\\s)${flag}(?:=|\\s+)([^\\s]+)`));
      if (match) return match[1].replace(/^['"]|['"]$/g, '');
    }
    return undefined;
  };

  const fmtNum = v => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` :
           n >= 1000 ? `${(n / 1000).toFixed(1)}K` :
           String(n);
  };

  const card = (label, value, opts = {}) => {
    const available = value !== undefined && value !== null && value !== '';
    const display = available ? String(value) : '—';
    const truncClass = (available && display.length > 40) ? ' truncated' : '';
    const titleAttr = truncClass ? ` title="${escapeHtml(display)}"` : '';
    return `<article class="model-detail-card ${opts.prominent ? 'prominent' : ''} ${available ? '' : 'unavailable'}">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value ${opts.big ? 'big' : ''}${truncClass}"${titleAttr}>${escapeHtml(display)}</span>
    </article>`;
  };

  const modelName = envVal(['SERVED_MODEL_NAME', 'MODEL', 'MODEL_NAME'], ['--served-model-name', '--model']) || (Array.isArray(models) && models.length ? models.join(', ') : '') || config?.image || '';
  const tp = envVal(['TP', 'TENSOR_PARALLEL_SIZE'], ['--tensor-parallel-size']);
  const dcp = envVal(['DCP', 'DATA_PARALLEL_SIZE'], ['--data-parallel-size']);
  const maxModelLen = envVal(['MAX_MODEL_LEN', 'MAX_SEQ_LEN', 'MAX_CONTEXT_LEN'], ['--max-model-len']) || fmtNum(runtime.max_model_len);
  const maxNumSeq = envVal(['MAX_NUM_SEQS'], ['--max-num-seqs']) || fmtNum(runtime.max_num_seq);
  const maxBatched = envVal(['MAX_NUM_BATCHED_TOKENS'], ['--max-num-batched-tokens']) || fmtNum(runtime.max_num_batched_tokens);
  const gpuMem = envVal(['GPU_MEMORY_UTILIZATION'], ['--gpu-memory-utilization']);
  const quant = envVal(['QUANTIZATION', 'DTYPE'], ['--quantization', '--dtype']);
  const gpus = envVal(['GPUS', 'GPU_COUNT', 'CUDA_VISIBLE_DEVICES']);
  const kvBlocks = fmtNum(runtime.num_gpu_blocks);
  const kvFree = fmtNum(runtime.num_free_blocks);
  const kvUsed = kvBlocks && kvFree ? `${Number(kvBlocks) - Number(kvFree)} / ${kvBlocks}` : (kvBlocks || '—');

  grid.innerHTML = [
    card('Model', modelName, { prominent: true, big: true }),
    card('Quantization', quant),
    card('Tensor Parallel', tp),
    card('Data Parallel', dcp),
    card('GPUs', gpus),
    card('GPU Memory Util', gpuMem),
    card('Max Model Len', maxModelLen, { prominent: true }),
    card('Max Num Seqs', maxNumSeq, { prominent: true }),
    card('Max Batched Tokens', maxBatched, { prominent: true }),
    card('KV Cache Blocks', kvUsed),
    card('Image', config?.image || '—'),
    card('Status', config?.status || '—'),
  ].join('');

  const meta = element('modelDetailsMeta');
  if (meta) {
    const parts = [];
    if (Object.keys(env).length) parts.push(`${Object.keys(env).length} env flags`);
    if (point?.status === 'ok') parts.push('Prometheus live');
    if (!parts.length) parts.push('Config from Docker inspect');
    meta.textContent = parts.join(' · ');
  }
}

export function renderLMCache(point) {
  const body = element('lmcacheBody');
  const meta = element('lmcacheMeta');
  if (!body) return;

  const health = point?.lmcache_health || {};
  const prom = point?.lmcache_prometheus || {};

  // No LMCache detected at all
  if (!Object.keys(health).length && !Object.keys(prom).length) {
    body.innerHTML = '<div class="empty">No LMCache detected on this workload. Set LMCACHE_* env vars or configure VLLM_OBSERVER_LMCACHE_URL.</div>';
    if (meta) meta.textContent = 'Not detected';
    return;
  }

  const parts = [];

  // Health badge
  const hc = health.healthcheck;
  const statusObj = health.status || {};
  const promHealthy = prom.is_healthy !== undefined ? prom.is_healthy === 1 : null;
  const isHealthy = hc?.status === 'healthy' || statusObj.is_healthy === true || promHealthy === true;
  const isUnreachable = health.unreachable && !hc && !statusObj.is_healthy;
  const badgeClass = isHealthy ? 'lmcache-badge healthy' : isUnreachable ? 'lmcache-badge unreachable' : 'lmcache-badge unhealthy';
  const badgeText = isHealthy ? 'HEALTHY' : isUnreachable ? 'UNREACHABLE' : 'UNHEALTHY';
  parts.push(`<div class="${badgeClass}">${badgeText}</div>`);

  // Health endpoint info
  if (health.url) {
    parts.push(`<div class="lmcache-url">Endpoint: <code>${escapeHtml(health.url)}</code></div>`);
  }

  // Version info
  const versionBits = [];
  if (health.lmc_version) versionBits.push(`LMCache ${escapeHtml(String(health.lmc_version))}`);
  if (health.version) versionBits.push(`vLLM ${escapeHtml(String(health.version))}`);
  if (health.commit_id) versionBits.push(`commit ${escapeHtml(String(health.commit_id).substring(0, 12))}`);
  if (versionBits.length) {
    parts.push(`<div class="lmcache-url">${versionBits.join(' · ')}</div>`);
  }

  // HTTP API status details
  if (Object.keys(statusObj).length) {
    const rows = [
      ['Engine', statusObj.engine_type],
      ['Chunk size', statusObj.chunk_size],
      ['Hash', statusObj.hash_algorithm],
      ['Active sessions', statusObj.active_sessions],
      ['GPU IDs', Array.isArray(statusObj.registered_gpu_ids) ? statusObj.registered_gpu_ids.join(', ') : statusObj.registered_gpu_ids],
      ['Prefetch jobs', statusObj.active_prefetch_jobs],
      ['Storage healthy', statusObj.storage_healthy === true ? 'yes' : statusObj.storage_healthy === false ? 'no' : '—'],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (rows.length) {
      parts.push('<div class="lmcache-subgrid">' + rows.map(([k, v]) =>
        `<div class="lmcache-cell"><span class="label">${escapeHtml(k)}</span><span class="value">${escapeHtml(String(v))}</span></div>`
      ).join('') + '</div>');
    }
  }

  // Operational state badges
  const opBadges = [];
  if (health.freeze !== undefined) {
    const fz = health.freeze ? 'frozen' : 'active';
    opBadges.push(`<span class="lmcache-badge small ${health.freeze ? 'unhealthy' : 'healthy'}">${fz.toUpperCase()}</span>`);
  }
  if (health.hot_cache !== undefined) {
    const hc2 = health.hot_cache ? 'ON' : 'OFF';
    opBadges.push(`<span class="lmcache-badge small ${health.hot_cache ? 'healthy' : ''}">HOT CACHE ${hc2}</span>`);
  }
  if (opBadges.length) {
    parts.push(`<div class="lmcache-ops-row">${opBadges.join(' ')}</div>`);
  }

  // Backends
  if (health.backends && typeof health.backends === 'object') {
    const backendEntries = Object.entries(health.backends);
    if (backendEntries.length) {
      parts.push('<div class="lmcache-section-label">Storage backends</div>');
      parts.push('<div class="lmcache-backend-list">' + backendEntries.map(([name, cls]) =>
        `<span class="lmcache-backend-chip">${escapeHtml(name)}: <code>${escapeHtml(String(cls))}</code></span>`
      ).join('') + '</div>');
    }
  }

  // Bypassed backends
  if (health.bypass) {
    const bypassed = health.bypass.bypassed || [];
    const allBackends = health.bypass.all || [];
    if (bypassed.length) {
      parts.push(`<div class="lmcache-bypass"><span class="lmcache-badge small unhealthy">BYPASSED</span> ${escapeHtml(bypassed.join(', '))}</div>`);
    } else if (allBackends.length) {
      parts.push('<div class="lmcache-bypass"><span class="lmcache-badge small healthy">NO BYPASS</span> <span class="section-meta">all backends active</span></div>');
    }
  }

  // Periodic threads health
  const pt = health.periodic_threads;
  if (pt) {
    const ptBadge = pt.healthy ? 'healthy' : 'unhealthy';
    parts.push(`<div class="lmcache-threads"><span class="lmcache-badge small ${ptBadge}">${pt.healthy ? 'THREADS OK' : 'THREADS FAILING'}</span> <span class="section-meta">${pt.unhealthy_count ?? 0} unhealthy${pt.unhealthy_threads?.length ? ': ' + pt.unhealthy_threads.map(t => escapeHtml(t.name || t)).join(', ') : ''}</span></div>`);
  }

  // Config
  if (health.config && Object.keys(health.config).length) {
    const confRows = Object.entries(health.config).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (confRows.length) {
      parts.push('<div class="lmcache-section-label">Configuration</div>');
      parts.push('<div class="lmcache-subgrid">' + confRows.map(([k, v]) =>
        `<div class="lmcache-cell"><span class="label">${escapeHtml(k)}</span><span class="value">${escapeHtml(String(v))}</span></div>`
      ).join('') + '</div>');
    }
  }

  // Prometheus metrics
  if (Object.keys(prom).length) {
    const promRows = [
      ['Retrieve hit rate', prom.retrieve_hit_rate != null ? `${(prom.retrieve_hit_rate * 100).toFixed(1)}%` : null],
      ['Lookup hit rate', prom.lookup_hit_rate != null ? `${(prom.lookup_hit_rate * 100).toFixed(1)}%` : null],
      ['Local cache usage', prom.local_cache_usage != null ? format(prom.local_cache_usage) : null],
      ['Remote cache usage', prom.remote_cache_usage != null ? format(prom.remote_cache_usage) : null],
      ['Retrieve speed', prom.retrieve_speed != null ? `${format(prom.retrieve_speed)} tok/s` : null],
      ['Store speed', prom.store_speed != null ? `${format(prom.store_speed)} tok/s` : null],
      ['Retrieve latency', prom.time_to_retrieve != null ? `${prom.time_to_retrieve.toFixed(1)} ms` : null],
      ['Store latency', prom.time_to_store != null ? `${prom.time_to_store.toFixed(1)} ms` : null],
      ['Hot cache count', prom.hot_cache_count],
      ['Active mem objs', prom.active_memory_objs],
      ['Pinned mem objs', prom.pinned_memory_objs],
      ['Evictions', prom.evict_count != null ? format(prom.evict_count) : null],
      ['Scheduler unfinished', prom.scheduler_unfinished],
      ['Connector KV caches', prom.connector_kv_caches],
    ].filter(([, v]) => v !== null && v !== undefined);
    if (promRows.length) {
      parts.push('<div class="lmcache-section-label">Prometheus metrics</div>');
      parts.push('<div class="lmcache-subgrid">' + promRows.map(([k, v]) =>
        `<div class="lmcache-cell"><span class="label">${escapeHtml(k)}</span><span class="value">${escapeHtml(String(v))}</span></div>`
      ).join('') + '</div>');
    }
  }

  body.innerHTML = parts.join('');

  if (meta) {
    const bits = [];
    if (isHealthy) bits.push('healthy');
    else if (isUnreachable) bits.push('unreachable');
    else bits.push('unhealthy');
    if (Object.keys(prom).length) bits.push(`${Object.keys(prom).length} prom metrics`);
    if (health.backends) bits.push(`${Object.keys(health.backends).length} backends`);
    if (health.lmc_version) bits.push(`v${health.lmc_version}`);
    if (health.url) bits.push('HTTP API');
    meta.textContent = bits.join(' · ');
  }
}

export function renderFullLogs(payload, opts = {}) {
  const container = element('fullLog');
  if (!container) return;
  const lines = payload.lines || [];
  const filterText = opts.filter || '';
  const focusLine = payload.focus_line;

  // Preserve scroll: if user is near bottom and follow is on, we keep them at bottom
  const wasNearBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 40;
  const filterLower = filterText.toLowerCase().trim();

  const html = lines.map(line => {
    const isMatch = filterLower && line.toLowerCase().includes(filterLower);
    const isFocus = focusLine && line === focusLine;
    return `<div${isMatch ? ' class="match"' : ''}${isFocus ? ' class="log-focus"' : ''}>${escapeHtml(line)}</div>`;
  }).join('');
  container.innerHTML = html || '<div class="empty">No log lines available.</div>';

  const meta = element('fullLogMeta');
  if (meta) {
    const shown = filterLower ? lines.filter(l => l.toLowerCase().includes(filterLower)).length : lines.length;
    meta.textContent = filterLower ? `${shown} / ${lines.length} lines` : `${lines.length} lines`;
  }

  if (opts.follow && wasNearBottom) {
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  }

  if (focusLine && !opts.follow) {
    const focused = [...container.querySelectorAll('div')].find(d => d.textContent === focusLine);
    if (focused) focused.scrollIntoView({ block: 'center' });
  }
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
