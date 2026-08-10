export function normalizeHistory(points, limit = 3600) {
  const byTimestamp = new Map();
  (Array.isArray(points) ? points : []).forEach(point => {
    if (point?.status === 'ok' && Number.isFinite(Number(point.timestamp))) {
      byTimestamp.set(Number(point.timestamp), point);
    }
  });
  return [...byTimestamp.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-Math.max(1, limit));
}

export function needsHistoryReload(history, point, maxGapMilliseconds = 5000) {
  if (point?.status !== 'ok' || !history.length) return false;
  const latest = Number(history.at(-1)?.timestamp);
  const incoming = Number(point.timestamp);
  return Number.isFinite(latest) && Number.isFinite(incoming) && incoming - latest > maxGapMilliseconds;
}

export function selectTimeWindow(history, endOffset = 0, windowSeconds = 60) {
  if (!history.length) return [];
  const end = Math.max(1, history.length - Math.max(0, endOffset));
  const endTimestamp = Number(history[end - 1].timestamp);
  const cutoff = endTimestamp - Math.max(1, windowSeconds) * 1000;
  let start = end - 1;
  while (start > 0 && Number(history[start - 1].timestamp) >= cutoff) start -= 1;
  return history.slice(start, end);
}
