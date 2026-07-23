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
    this.focusTimestamp = null;
    this.hoverTimestamp = null;
    this.crosshairEnabled = true;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    canvas.parentElement.appendChild(this.tooltip);
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointermove', event => this.handlePointerMove(event));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverTimestamp = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    this.canvas.addEventListener('click', event => {
      if (!this.points.length || !this.options.onPoint) return;
      const rect = this.canvas.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const minTime = this.points[0]?.timestamp || Date.now();
      const maxTime = this.points.at(-1)?.timestamp || minTime + 1000;
      const target = minTime + (maxTime - minTime) * fraction;
      const point = this.points.reduce((nearest, candidate) =>
        Math.abs(candidate.timestamp - target) < Math.abs(nearest.timestamp - target) ? candidate : nearest
      );
      this.options.onPoint(point);
    });
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas);
  }

  update(points, subdivisions, focusTimestamp = null) {
    this.points = points;
    this.subdivisions = subdivisions;
    this.focusTimestamp = focusTimestamp;
    this.draw();
  }

  setCrosshair(enabled) {
    this.crosshairEnabled = enabled;
    if (!enabled) {
      this.hoverTimestamp = null;
      this.tooltip.hidden = true;
    }
    this.draw();
  }

  timestampAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const minTime = this.points[0]?.timestamp || Date.now();
    const maxTime = this.points.at(-1)?.timestamp || minTime + 1000;
    return minTime + (maxTime - minTime) * fraction;
  }

  handlePointerMove(event) {
    if (!this.crosshairEnabled || !this.points.length) return;
    this.hoverTimestamp = this.timestampAtClientX(event.clientX);
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    this.tooltip.innerHTML = '<strong>' + new Date(this.hoverTimestamp).toLocaleTimeString() + '</strong>' +
      this.series.map(series => {
        const value = this.valueAt(series.path, this.hoverTimestamp);
        return '<span><i style="background:' + series.color + '"></i>' +
          (series.label || series.path) + ': ' + formatValue(value) + (series.unit || '') + '</span>';
      }).join('');
    this.tooltip.style.left = Math.min(Math.max(8, localX + 14), Math.max(8, rect.width - 190)) + 'px';
    this.tooltip.style.top = Math.min(Math.max(8, localY - 18), Math.max(8, rect.height - 110)) + 'px';
    this.tooltip.hidden = false;
    this.draw();
  }

  valueAt(path, timestamp) {
    const values = this.points
      .map(point => ({ x: point.timestamp, y: Number(pick(point, path)) }))
      .filter(point => Number.isFinite(point.y));
    if (!values.length) return null;
    if (timestamp <= values[0].x) return values[0].y;
    if (timestamp >= values.at(-1).x) return values.at(-1).y;
    const after = values.find(point => point.x >= timestamp);
    const before = values[values.indexOf(after) - 1];
    if (this.options.discrete) return before.y;
    const fraction = (timestamp - before.x) / (after.x - before.x);
    return before.y + (after.y - before.y) * fraction;
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

    const guideTimestamp = this.hoverTimestamp || this.focusTimestamp;
    if (guideTimestamp && guideTimestamp >= minTime && guideTimestamp <= maxTime) {
      context.strokeStyle = '#172124';
      context.setLineDash([4, 4]);
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(x(guideTimestamp), margin.top);
      context.lineTo(x(guideTimestamp), margin.top + plotHeight);
      context.stroke();
      context.setLineDash([]);
    }

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
      const displayPoints = this.options.discrete ? realPoints : interpolate(realPoints, this.subdivisions);
      context.strokeStyle = series.color;
      context.lineWidth = 2;
      context.lineJoin = 'round';
      context.beginPath();
      if (this.options.discrete) {
        context.moveTo(x(displayPoints[0].x), y(displayPoints[0].y));
        displayPoints.slice(1).forEach(point => {
          const previous = displayPoints[displayPoints.indexOf(point) - 1];
          context.lineTo(x(point.x), y(previous.y));
          context.lineTo(x(point.x), y(point.y));
        });
      } else {
        displayPoints.forEach((point, index) => {
          const method = index ? 'lineTo' : 'moveTo';
          context[method](x(point.x), y(point.y));
        });
      }
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

function formatValue(value) {
  if (value === null || value === undefined) return 'not reported';
  if (Math.abs(value) >= 1000) return compact(value);
  return Number(value).toFixed(1);
}
