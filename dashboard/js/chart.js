const pick = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

function interpolate(points, subdivisions) {
  if (subdivisions <= 0 || points.length < 3) return points;
  const intervals = points.slice(0, -1).map((point, index) => points[index + 1].x - point.x);
  const slopes = intervals.map((interval, index) => (points[index + 1].y - points[index].y) / interval);
  const tangents = points.map((point, index) => {
    if (index === 0) return endpointSlope(intervals[0], intervals[1], slopes[0], slopes[1]);
    if (index === points.length - 1) {
      const last = intervals.length - 1;
      return endpointSlope(intervals[last], intervals[last - 1], slopes[last], slopes[last - 1]);
    }
    if (slopes[index - 1] === 0 || slopes[index] === 0 || Math.sign(slopes[index - 1]) !== Math.sign(slopes[index])) return 0;
    const leftWeight = 2 * intervals[index] + intervals[index - 1];
    const rightWeight = intervals[index] + 2 * intervals[index - 1];
    return (leftWeight + rightWeight) /
      (leftWeight / slopes[index - 1] + rightWeight / slopes[index]);
  });
  const output = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const interval = intervals[index];
    for (let step = 0; step <= subdivisions; step += 1) {
      const t = step / (subdivisions + 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * start.y +
        (t3 - 2 * t2 + t) * interval * tangents[index] +
        (-2 * t3 + 3 * t2) * end.y +
        (t3 - t2) * interval * tangents[index + 1];
      output.push({
        x: start.x + interval * t,
        y: Math.max(0, y),
        real: step === 0,
      });
    }
  }
  output.push({ ...points.at(-1), real: true });
  return output;
}

function endpointSlope(interval, adjacentInterval, slope, adjacentSlope) {
  let tangent = ((2 * interval + adjacentInterval) * slope - interval * adjacentSlope) /
    (interval + adjacentInterval);
  if (Math.sign(tangent) !== Math.sign(slope)) tangent = 0;
  else if (Math.sign(slope) !== Math.sign(adjacentSlope) && Math.abs(tangent) > Math.abs(3 * slope)) {
    tangent = 3 * slope;
  }
  return tangent;
}

export class TimeSeriesChart {
  constructor(canvas, series, options = {}) {
    this.canvas = canvas;
    this.series = series;
    this.options = options;
    this.points = [];
    this.subdivisions = 0;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);
  }

  update(points, subdivisions) {
    this.points = points;
    this.subdivisions = subdivisions;
    this.draw();
  }

  draw() {
    const canvas = this.canvas;
    const width = Math.max(280, canvas.clientWidth);
    const height = Math.max(220, canvas.clientHeight);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.body);
    const muted = styles.getPropertyValue('--muted').trim();
    const grid = styles.getPropertyValue('--line').trim();
    const background = styles.getPropertyValue('--panel').trim();
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);

    const margin = { top: 18, right: 16, bottom: 30, left: 52 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const available = this.series.flatMap(series =>
      this.points
        .map(point => Number(pick(point, series.path)))
        .filter(Number.isFinite)
    );
    if (!available.length) {
      context.fillStyle = muted;
      context.font = '13px ui-monospace, monospace';
      context.textAlign = 'center';
      context.fillText(this.options.empty || 'No real samples for this metric yet', width / 2, height / 2);
      return;
    }

    const max = this.options.max || Math.max(1, ...available) * 1.12;
    const minTime = this.points[0]?.timestamp || Date.now();
    const maxTime = this.points.at(-1)?.timestamp || minTime + 1000;
    const timeSpan = Math.max(1000, maxTime - minTime);
    const x = value => margin.left + ((value - minTime) / timeSpan) * plotWidth;
    const y = value => margin.top + plotHeight - (Math.max(0, value) / max) * plotHeight;

    context.strokeStyle = grid;
    context.fillStyle = muted;
    context.font = '11px ui-monospace, monospace';
    context.lineWidth = 1;
    context.textAlign = 'right';
    for (let line = 0; line <= 4; line += 1) {
      const value = max * line / 4;
      const lineY = y(value);
      context.beginPath();
      context.moveTo(margin.left, lineY);
      context.lineTo(width - margin.right, lineY);
      context.stroke();
      context.fillText(this.options.percent ? `${value.toFixed(0)}%` : compact(value), margin.left - 8, lineY + 4);
    }

    context.textAlign = 'center';
    [0, 0.5, 1].forEach(position => {
      const timestamp = minTime + timeSpan * position;
      context.fillText(new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }), margin.left + plotWidth * position, height - 8);
    });

    this.series.forEach(series => {
      const realPoints = this.points
        .map(point => ({ x: point.timestamp, y: Number(pick(point, series.path)), real: true }))
        .filter(point => Number.isFinite(point.y));
      if (!realPoints.length) return;
      const displayPoints = interpolate(realPoints, this.subdivisions);
      context.strokeStyle = series.color;
      context.lineWidth = 2;
      context.lineJoin = 'round';
      context.beginPath();
      displayPoints.forEach((point, index) => {
        const method = index ? 'lineTo' : 'moveTo';
        context[method](x(point.x), y(point.y));
      });
      context.stroke();

      context.fillStyle = series.color;
      realPoints.forEach(point => {
        context.beginPath();
        context.arc(x(point.x), y(point.y), 2.5, 0, Math.PI * 2);
        context.fill();
      });
    });
  }
}

function compact(value) {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}
