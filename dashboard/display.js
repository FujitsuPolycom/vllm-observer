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

function pchipPoints(points, subdivisions) {
    if (points.length < 2) return points;
    const slopes = points.slice(0, -1).map((point, index) => point.y - points[index].y);
    const tangents = points.map((point, index) => {
        if (index === 0) return slopes[0];
        if (index === points.length - 1) return slopes[slopes.length - 1];
        const left = slopes[index - 1];
        const right = slopes[index];
        return left * right <= 0 ? 0 : (2 * left * right) / (left + right);
    });
    const output = [];
    points.slice(0, -1).forEach((point, index) => {
        const next = points[index + 1];
        const count = subdivisions + 1;
        for (let step = 0; step < count; step += 1) {
            const t = step / count;
            const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
            const h10 = t ** 3 - 2 * t ** 2 + t;
            const h01 = -2 * t ** 3 + 3 * t ** 2;
            const h11 = t ** 3 - t ** 2;
            output.push({ x: point.x + (next.x - point.x) * t, y: Math.max(0, h00 * point.y + h10 * tangents[index] + h01 * next.y + h11 * tangents[index + 1]) });
        }
    });
    output.push(points[points.length - 1]);
    return output;
}

function renderLiveGraph(history, subdivisions = 6) {
    const host = document.getElementById('liveChart');
    const output = document.getElementById('smoothnessValue');
    if (output) output.textContent = subdivisions;
    if (!host || history.length < 2) { if (host) host.innerHTML = '<div class="empty">Waiting for two or more Prometheus samples.</div>'; return; }
    const width = 1000; const height = 250; const pad = 24;
    const series = [{ key: 'fresh_prefill_tokens_per_second', color: '#77a8ff' }, { key: 'cached_ingest_tokens_per_second', color: '#52d1df' }, { key: 'decode_tokens_per_second', color: '#62db91' }];
    const max = Math.max(1, ...series.flatMap(item => history.map(sample => Number(sample[item.key] || 0))));
    const x = index => pad + (index / (history.length - 1)) * (width - pad * 2);
    const pathFor = key => pchipPoints(history.map((sample, index) => ({ x: x(index), y: height - pad - (Number(sample[key] || 0) / max) * (height - pad * 2) })), subdivisions).map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Prometheus live token rate history"><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#607078" stroke-width="1"/>${series.map(item => `<path d="${pathFor(item.key)}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}<text x="${pad}" y="16" fill="#91a1a8" font-size="11">0 - ${max.toFixed(1)} tok/s · ${history.length} real samples</text></svg>`;
}
