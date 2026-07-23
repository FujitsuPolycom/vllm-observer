const state = { instances: [], selected: '', paused: false, inventorySignature: '', metricSignature: '', values: {}, live: {}, liveHistory: [], historyOffset: 0 };
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const labels = { prompt_tokens_per_second: 'Prefill / prompt', generation_tokens_per_second: 'Decode / generation', gpu_kv_cache_percent: 'GPU KV cache', prefix_cache_hit_percent: 'Prefix cache hit', external_prefix_cache_hit_percent: 'External prefix hit', speculative_mean_acceptance_length: 'MTP acceptance length', speculative_depth: 'MTP speculative depth', accepted_tokens_per_second: 'Accepted throughput', drafted_tokens_per_second: 'Drafted throughput', draft_acceptance_percent: 'Draft acceptance', lmcache_total_tokens: 'LMCache total', lmcache_computed_tokens: 'LMCache computed', lmcache_hit_tokens: 'LMCache hit', lmcache_load_tokens: 'LMCache load', cache_transfer_chunks: 'CKV / cache chunks', running_requests: 'Running requests', waiting_requests: 'Queued requests' };
const units = { prompt_tokens_per_second: 'tok/s', generation_tokens_per_second: 'tok/s', fresh_prefill_tokens_per_second: 'tok/s', cached_ingest_tokens_per_second: 'tok/s', decode_tokens_per_second: 'tok/s', cache_hit_percent: '%', accepted_tokens_per_second: 'tok/s', drafted_tokens_per_second: 'tok/s', draft_acceptance_percent: '%', cache_transfer_chunks: 'chunks' };
const liveLabels = { fresh_prefill_tokens_per_second: 'Fresh prefill', cached_ingest_tokens_per_second: 'Cached ingest', decode_tokens_per_second: 'Decode', cache_hit_percent: 'Cache hit', running_requests: 'Running', waiting_requests: 'Queued' };
const liveKeys = ['fresh_prefill_tokens_per_second', 'cached_ingest_tokens_per_second', 'decode_tokens_per_second', 'cache_hit_percent', 'running_requests', 'waiting_requests'];

function format(key, value) { return `${Number.isInteger(value) ? value : Number(value).toFixed(1)}${units[key] ? ` ${units[key]}` : ''}`; }
function historyKey() { return `vllm-observer:prometheus-history:${state.selected}`; }
function updateHistoryControls() { const slider = $('historyPosition'); const max = Math.max(0, state.liveHistory.length - 90); state.historyOffset = Math.min(state.historyOffset, max); slider.max = max; slider.value = state.historyOffset; slider.disabled = max === 0; $('historyLabel').textContent = max === 0 ? 'latest' : state.historyOffset ? `${state.historyOffset}s back` : 'latest'; }
function renderHistory() { updateHistoryControls(); renderLiveGraph(state.liveHistory, Number($('smoothness').value), state.historyOffset); }
function restoreHistory() { state.historyOffset = 0; try { const saved = JSON.parse(localStorage.getItem(historyKey()) || '[]'); state.liveHistory = Array.isArray(saved) ? saved.filter(sample => sample && Number.isFinite(sample.time)).slice(-900) : []; } catch (error) { state.liveHistory = []; } renderHistory(); }

function renderConfig(item) {
    if (!item) { $('config').innerHTML = '<div class="config-panel"><div class="empty">No workload selected.</div></div>'; return; }
    const env = item.env || {};
    const groupDefs = [
        ['Model identity', key => ['MODEL', 'MODEL_FAMILY', 'SERVED_MODEL_NAME', 'QUANTIZATION', 'MOE_MODE', 'LOAD_FORMAT'].includes(key)],
        ['Serving and batching', key => key === 'PORT' || key === 'GRAPH' || key.startsWith('MAX_')],
        ['KV cache and LMCache', key => key.startsWith('KV_') || key.startsWith('LMCACHE_') || key === 'KV_TRANSFER_CONFIG'],
        ['Parallelism and routing', key => ['TP', 'DCP', 'MTP', 'GPUS', 'DCP_BACKEND', 'ALLREDUCE_MODE'].includes(key) || key.startsWith('VLLM_DCP_')],
        ['Kernel and throughput tuning', key => key.startsWith('VLLM_') || key.startsWith('B12X_') || key.startsWith('F8_')],
        ['CUDA, NCCL, and accelerators', key => key.startsWith('CUDA_') || key.startsWith('NCCL_') || key.startsWith('FLASHINFER_') || key.startsWith('INSTANTTENSOR_')],
        ['Paths and build', key => key.endsWith('_DIR') || key.endsWith('_PATH') || key.endsWith('_VERSION') || ['VIRTUAL_ENV', 'LD_LIBRARY_PATH', 'XDG_CACHE_HOME', 'PYTHONHASHSEED'].includes(key)]
    ];
    const used = new Set();
    const groups = groupDefs.map(([title, matches]) => [title, Object.keys(env).filter(key => !used.has(key) && matches(key))]).filter(([, keys]) => keys.length);
    groups.forEach(([, keys]) => keys.forEach(key => used.add(key)));
    const remaining = Object.keys(env).filter(key => !used.has(key));
    if (remaining.length) groups.push(['Other runtime', remaining]);
    const row = ([key, value]) => `<div class="config-row"><span class="config-key">${esc(key)}</span><code class="config-value">${esc(value)}</code></div>`;
    const core = [['Image', item.image], ['Command', item.command || 'default'], ['Status', item.status], ['Network', item.network_mode || 'default'], ['PID', item.pid ?? 'n/a'], ['Mounts', (item.mounts || []).map(mount => `${mount.source} -> ${mount.destination}`).join(' | ') || 'none']];
    const corePanel = `<section class="config-panel"><h3>Selected container</h3><div class="config-list">${core.map(row).join('')}</div></section>`;
    const groupPanels = groups.map(([title, keys]) => `<details class="config-panel"><summary><span>${esc(title)}</span><span class="config-count">${keys.length} settings · expand</span></summary><div class="config-list">${keys.map(key => row([key, env[key]])).join('')}</div></details>`).join('');
    $('config').innerHTML = corePanel + groupPanels;
    $('configMeta').textContent = `${Object.keys(env).length} runtime flags · groups collapsed by default`;
}

function renderSelect() {
    const select = $('instance');
    select.innerHTML = state.instances.length ? state.instances.map(item => `<option value="${esc(item.name)}">${item.running ? '●' : '○'} ${esc(item.name)}${item.running ? '' : ' · stopped'}</option>`).join('') : '<option value="">No workloads found</option>';
    select.value = state.selected;
}

function renderMetrics(values, live) {
    const liveAvailable = live && live.available && liveKeys.some(key => live[key] !== undefined);
    const keys = liveAvailable ? liveKeys.filter(key => live[key] !== undefined) : Object.keys(values || {});
    const source = liveAvailable ? 'LIVE · Prometheus counter deltas' : 'LOG SNAPSHOT · coarse rolling logger';
    const signature = `${source}|${keys.join('|')}`;
    const host = $('metrics');
    if (host.dataset.signature === signature && host.children.length === keys.length) {
        keys.forEach((key, index) => {
            const card = host.children[index];
            const value = liveAvailable ? live[key] : values[key];
            card.querySelector('.metric-value').textContent = format(key, value);
            card.querySelector('.metric-note').textContent = liveAvailable ? source : 'latest observed value';
        });
    } else {
        host.dataset.signature = signature;
        host.innerHTML = keys.length ? keys.map(key => {
            const isLive = liveAvailable;
            const value = isLive ? live[key] : values[key];
            return `<article class="metric"><div class="metric-label">${esc((isLive ? liveLabels[key] : labels[key]) || key.replaceAll('_', ' '))}</div><div class="metric-value">${esc(format(key, value))}</div><div class="metric-note">${isLive ? source : 'latest observed value'}</div></article>`;
        }).join('') : '<article class="metric unavailable"><div class="metric-label">Performance</div><div class="metric-value">not reported</div><div class="metric-note">this workload emitted no recognized metrics</div></article>';
    }
    $('metricMeta').textContent = keys.length ? `${source} · ${keys.length} values` : 'no metrics found';
}

function renderLogs(groups) {
    const names = [['lmcache', 'LMCache / KV transfer'], ['prefill', 'Prefill / prompt'], ['decode', 'Decode / engine'], ['requests', 'Requests / serving'], ['other', 'Other / startup / warnings']];
    names.forEach(([key, title]) => {
        const body = $(`log-${key}`);
        const scroll = body.scrollTop;
        const lines = groups[key] || [];
        $(`count-${key}`).textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}`;
        body.innerHTML = lines.length ? lines.map(line => `<div class="line">${esc(line)}</div>`).join('') : '<div class="empty">No matching lines yet.</div>';
        body.scrollTop = scroll;
    });
}

async function loadInstances() {
    if (state.paused) return;
    try {
        const response = await fetch('/api/instances', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'observer unavailable');
        const instances = data.instances || [];
        const signature = instances.map(item => `${item.name}:${item.status}:${item.id}`).join('|');
        const selectedStillExists = instances.some(item => item.name === state.selected);
        const selectedChanged = !selectedStillExists;
        state.instances = instances;
        if (selectedChanged) state.selected = instances[0]?.name || '';
        if (signature !== state.inventorySignature || selectedChanged) {
            state.inventorySignature = signature;
            renderSelect();
            if (selectedChanged) restoreHistory();
            renderConfig(state.instances.find(item => item.name === state.selected));
        }
        $('status').textContent = 'observer live';
        $('status').className = 'ok';
    } catch (error) {
        $('status').textContent = 'observer unavailable';
        $('status').className = 'bad';
        $('refresh').textContent = error.message;
    }
}

async function loadLogs() {
    if (state.paused || !state.selected) return;
    try {
        const response = await fetch(`/api/logs?instance=${encodeURIComponent(state.selected)}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'log read failed');
        state.values = data.metrics || {};
        state.live = data.live_metrics || {};
        renderMetrics(state.values, state.live);
        renderLogs(data.groups || {});
        $('sampleTime').textContent = new Date().toLocaleTimeString();
        $('logMeta').textContent = `${data.lines?.length || 0} lines fetched`;
        $('status').textContent = 'observer live';
        $('status').className = 'ok';
    } catch (error) {
        $('status').textContent = 'log read failed';
        $('status').className = 'bad';
        $('logMeta').textContent = error.message;
    }
}

function recordLive(live) {
    if (!live || !live.available) return;
    const sample = { time: Date.now() };
    ['fresh_prefill_tokens_per_second', 'cached_ingest_tokens_per_second', 'decode_tokens_per_second'].forEach(key => { if (live[key] !== undefined) sample[key] = Number(live[key]); });
    if (Object.keys(sample).length > 1) { state.liveHistory = [...state.liveHistory, sample].slice(-900); try { localStorage.setItem(historyKey(), JSON.stringify(state.liveHistory)); } catch (error) { /* local cache is optional */ } renderHistory(); }
}

async function loadLive() {
    if (state.paused || !state.selected) return;
    try {
        const response = await fetch(`/api/live?instance=${encodeURIComponent(state.selected)}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'live metrics unavailable');
        state.live = data.live_metrics || {};
        recordLive(state.live);
        renderMetrics(state.values, state.live);
    } catch (error) {
        // The slower log poll remains the fallback source when Prometheus is unavailable.
    }
}

$('instance').addEventListener('change', event => { state.selected = event.target.value; restoreHistory(); renderConfig(state.instances.find(item => item.name === state.selected)); loadLogs(); });
$('pause').addEventListener('click', () => { state.paused = !state.paused; $('pause').textContent = state.paused ? 'Resume' : 'Pause'; $('pause').classList.toggle('active', state.paused); if (!state.paused) { loadInstances(); loadLogs(); } });
$('styleToggle').addEventListener('click', () => { document.body.classList.toggle('minimal'); $('styleToggle').textContent = document.body.classList.contains('minimal') ? 'Rich view' : 'Minimal view'; });
$('compose').addEventListener('click', async () => { const suffix = state.selected ? `?instance=${encodeURIComponent(state.selected)}` : ''; const response = await fetch(`/api/compose${suffix}`); if (!response.ok) { $('refresh').textContent = 'compose build failed'; return; } const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${state.selected || 'vllm-observer'}.compose.yml`; link.click(); URL.revokeObjectURL(link.href); });
$('smoothness').addEventListener('input', event => { renderHistory(); });
$('historyPosition').addEventListener('input', event => { state.historyOffset = Number(event.target.value); renderHistory(); });
loadInstances().then(() => { restoreHistory(); return loadLogs(); });
setInterval(() => { if (!document.hidden) loadLogs(); }, 3000);
setInterval(() => { if (!document.hidden) loadLive(); }, 1000);
setInterval(() => { if (!document.hidden) loadInstances(); }, 15000);
