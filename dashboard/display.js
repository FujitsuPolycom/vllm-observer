/* Performance display intentionally uses Prometheus only. Log text is never used as a rate fallback. */
const smoothedLive = {};
function renderMetrics(values, live) {
    const cards = [];
    const add = (key, label, value, note, unit, smooth = false) => {
        if (value !== undefined && value !== null) {
            if (smooth && Number.isFinite(Number(value))) {
                const current = Number(value);
                smoothedLive[key] = smoothedLive[key] === undefined ? current : smoothedLive[key] + (current - smoothedLive[key]) * 0.35;
                value = smoothedLive[key];
                note = `${note} · smoothed`;
            }
            cards.push({ key, label, value, note, unit });
        }
    };
    const liveAvailable = live && live.available;
    if (liveAvailable) {
        add('fresh_prefill_tokens_per_second', 'Fresh prefill', live.fresh_prefill_tokens_per_second, 'LIVE · 1s counter delta', 'tok/s', true);
        add('cached_ingest_tokens_per_second', 'Cached ingest', live.cached_ingest_tokens_per_second, 'LIVE · 1s counter delta', 'tok/s', true);
        add('decode_tokens_per_second', 'Decode', live.decode_tokens_per_second, 'LIVE · 1s counter delta', 'tok/s', true);
        add('cache_hit_percent', 'Cache hit', live.cache_hit_percent, 'LIVE · 1s counter delta', '%', true);
        add('running_requests', 'Running', live.running_requests, 'LIVE · current gauge', '');
        add('waiting_requests', 'Queued', live.waiting_requests, 'LIVE · current gauge', '');
    }
    const signature = cards.map(card => card.key).join('|');
    const host = document.getElementById('metrics');
    const valueText = card => `${Number.isInteger(card.value) ? card.value : Number(card.value).toFixed(1)}${card.unit ? ` ${card.unit}` : ''}`;
    if (host.dataset.signature === signature && host.children.length === cards.length) {
        cards.forEach((card, index) => { host.children[index].querySelector('.metric-value').textContent = valueText(card); host.children[index].querySelector('.metric-note').textContent = card.note; });
    } else {
        host.dataset.signature = signature;
        host.innerHTML = cards.length ? cards.map(card => `<article class="metric"><div class="metric-label">${esc(card.label)}</div><div class="metric-value">${esc(valueText(card))}</div><div class="metric-note">${esc(card.note)}</div></article>`).join('') : '<article class="metric unavailable"><div class="metric-label">Performance</div><div class="metric-value">not reported</div><div class="metric-note">no performance values were emitted</div></article>';
    }
    document.getElementById('metricMeta').textContent = cards.length ? 'LIVE · Prometheus counter deltas · 1s samples' : 'waiting for Prometheus';
}
