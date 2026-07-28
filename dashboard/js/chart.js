import { formatTime } from './time.js';

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

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function gapLimit(points) {
  const intervals = points.slice(1)
    .map((point, index) => point.timestamp - points[index].timestamp)
    .filter(interval => interval > 0);
  return Math.max(5000, (median(intervals) || 1000) * 3);
}

function splitAtGaps(points, limit) {
  if (points.length < 2) return [points];
  const segments = [[]];
  points.forEach((point, index) => {
    if (index && point.x - points[index - 1].x > limit) segments.push([]);
    segments.at(-1).push(point);
  });
  return segments.filter(segment => segment.length);
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
    this.gapLimit = 5000;
    this.bridgeGaps = true;
    this.zoomLevel = 1;
    this.zoomCenter = 0.5;
    this.isDragging = false;
    this.wasDragging = false;
    this.visibleSeries = new Set(series.map(item => item.path));
    this.tooltipAnchor = null;
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    canvas.parentElement.appendChild(this.tooltip);
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointermove', event => this.handlePointerMove(event));
    this.canvas.addEventListener('wheel', event => this.handleWheel(event), { passive: false });
    this.canvas.addEventListener('pointerdown', event => this.handlePointerDown(event));
    this.canvas.addEventListener('pointerleave', () => {
      this.hoverTimestamp = null;
      this.tooltip.hidden = true;
      this.options.onLeave?.();
      this.draw();
    });
    this.canvas.addEventListener('click', event => {
      if (this.wasDragging) { this.wasDragging = false; return; }
      if (!this.points.length || !this.options.onPoint) return;
      const target = this.timestampAtClientX(event.clientX);
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
    this.gapLimit = gapLimit(points);
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

  setBridgeGaps(enabled) {
    this.bridgeGaps = enabled;
    this.draw();
  }

  getZoomedRange() {
    if (!this.points.length) return { minTime: Date.now(), maxTime: Date.now() + 1000 };
    const fullMin = this.points[0].timestamp;
    const fullMax = this.points.at(-1).timestamp;
    const fullSpan = Math.max(1000, fullMax - fullMin);
    const halfRange = fullSpan / (2 * this.zoomLevel);
    const centerTime = fullMin + fullSpan * this.zoomCenter;
    const minTime = Math.max(fullMin, centerTime - halfRange);
    const maxTime = Math.min(fullMax, centerTime + halfRange);
    return { minTime, maxTime };
  }

  setZoom(level, center) {
    this.zoomLevel = Math.max(1, Math.min(50, level));
    this.zoomCenter = Math.max(0, Math.min(1, center));
    this.draw();
  }

  resetZoom() {
    this.zoomLevel = 1;
    this.zoomCenter = 0.5;
    this.draw();
  }

  zoomBy(factor, anchorFraction) {
    if (!this.points.length) return;
    const { minTime, maxTime } = this.getZoomedRange();
    const timeSpan = maxTime - minTime;
    const anchorTime = minTime + anchorFraction * timeSpan;
    const newLevel = Math.max(1, Math.min(50, this.zoomLevel * factor));
    if (newLevel === this.zoomLevel) return;
    const fullMin = this.points[0].timestamp;
    const fullMax = this.points.at(-1).timestamp;
    const fullSpan = Math.max(1000, fullMax - fullMin);
    let newCenter = (anchorTime - fullMin) / fullSpan;
    const halfRangeFraction = 1 / (2 * newLevel);
    newCenter = Math.max(halfRangeFraction, Math.min(1 - halfRangeFraction, newCenter));
    this.zoomLevel = newLevel;
    this.zoomCenter = newCenter;
    this.options.onZoom?.(this.zoomLevel, this.zoomCenter);
    this.draw();
  }

  handleWheel(event) {
    if (!this.points.length) return;
    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const margin = { left: 52, right: 16 };
    const plotWidth = Math.max(1, rect.width - margin.left - margin.right);
    const mouseFraction = Math.max(0, Math.min(1, (event.clientX - rect.left - margin.left) / plotWidth));
    const factor = event.deltaY > 0 ? 1 / 1.3 : 1.3;
    this.zoomBy(factor, mouseFraction);
  }

  handlePointerDown(event) {
    if (!this.points.length || this.zoomLevel <= 1.01) return;
    this.isDragging = true;
    this.wasDragging = false;
    this.dragStartX = event.clientX;
    this.dragStartCenter = this.zoomCenter;
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.addEventListener('pointermove', this.dragMoveHandler = event => this.handleDragMove(event));
    this.canvas.addEventListener('pointerup', this.dragEndHandler = event => this.handleDragEnd(event), { once: true });
  }

  handleDragMove(event) {
    if (!this.isDragging) return;
    const rect = this.canvas.getBoundingClientRect();
    const margin = { left: 52, right: 16 };
    const plotWidth = Math.max(1, rect.width - margin.left - margin.right);
    const dx = event.clientX - this.dragStartX;
    if (Math.abs(dx) > 3) this.wasDragging = true;
    const fullMin = this.points[0].timestamp;
    const fullMax = this.points.at(-1).timestamp;
    const fullSpan = Math.max(1000, fullMax - fullMin);
    const fractionShift = dx / plotWidth / this.zoomLevel;
    let newCenter = this.dragStartCenter - fractionShift;
    const halfRangeFraction = 1 / (2 * this.zoomLevel);
    newCenter = Math.max(halfRangeFraction, Math.min(1 - halfRangeFraction, newCenter));
    this.zoomCenter = newCenter;
    this.options.onZoom?.(this.zoomLevel, this.zoomCenter);
    this.draw();
  }

  handleDragEnd(event) {
    this.isDragging = false;
    if (this.dragMoveHandler) {
      this.canvas.removeEventListener('pointermove', this.dragMoveHandler);
      this.dragMoveHandler = null;
    }
    if (event && event.pointerId !== undefined) {
      try { this.canvas.releasePointerCapture(event.pointerId); } catch (e) { /* already released */ }
    }
  }

  setSeriesVisible(path, visible) {
    if (visible) this.visibleSeries.add(path);
    else this.visibleSeries.delete(path);
    this.draw();
  }

  setHoverTimestamp(timestamp, showTooltip = false) {
    if (!this.crosshairEnabled) return;
    this.hoverTimestamp = timestamp;
    if (!timestamp) {
      this.tooltip.hidden = true;
    } else if (showTooltip) {
      this.renderTooltip();
      this.positionTooltip(this.localXForTimestamp(timestamp), 12);
      this.tooltip.hidden = false;
    }
    this.draw();
  }

  timestampAtClientX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const margin = { left: 52, right: 16 };
    const plotWidth = Math.max(1, rect.width - margin.left - margin.right);
    const fraction = Math.max(0, Math.min(1, (clientX - rect.left - margin.left) / plotWidth));
    const { minTime, maxTime } = this.getZoomedRange();
    return minTime + (maxTime - minTime) * fraction;
  }

  localXForTimestamp(timestamp) {
    const margin = { left: 52, right: 16 };
    const { minTime, maxTime } = this.getZoomedRange();
    const fraction = Math.max(0, Math.min(1, (timestamp - minTime) / Math.max(1, maxTime - minTime)));
    return margin.left + fraction * Math.max(1, this.canvas.clientWidth - margin.left - margin.right);
  }

  handlePointerMove(event) {
    if (this.isDragging) return;
    if (!this.crosshairEnabled || !this.points.length) return;
    this.hoverTimestamp = this.timestampAtClientX(event.clientX);
    this.options.onHover?.(this.hoverTimestamp);
    const rect = this.canvas.getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    this.renderTooltip();
    this.positionTooltip(localX, localY);
    this.tooltip.hidden = false;
    this.draw();
  }

  renderTooltip() {
    const tooltipRows = this.options.tooltipRows?.(path => this.valueAt(path, this.hoverTimestamp)) || [];
    const extraTooltip = tooltipRows.length
      ? '<div class="chart-tooltip-section"><b>Per-request context</b>' + tooltipRows.map(([label, value, unit]) =>
        '<span>' + label + ': ' + formatValue(value) + (unit || '') + '</span>').join('') + '</div>'
      : '';
    this.tooltip.innerHTML = '<strong>' + formatTime(this.hoverTimestamp, true) + '</strong>' +
      this.series.filter(series => this.visibleSeries.has(series.path)).map(series => {
        const value = this.valueAt(series.path, this.hoverTimestamp);
        return '<span><i style="background:' + series.color + '"></i>' +
          (series.label || series.path) + ': ' + formatValue(value) + (series.unit || '') + '</span>';
      }).join('') + extraTooltip;
  }

  positionTooltip(localX, localY) {
    const rect = this.canvas.getBoundingClientRect();
    const tooltipWidth = this.tooltip.offsetWidth;
    const gap = 14;
    const maxLeft = Math.max(8, rect.width - tooltipWidth - 8);
    const rightLeft = localX + gap;
    const leftLeft = localX - tooltipWidth - gap;
    const left = rightLeft <= maxLeft
      ? Math.max(8, rightLeft)
      : leftLeft >= 8
        ? leftLeft
        : maxLeft;
    const top = Math.min(Math.max(8, localY - 18), Math.max(8, rect.height - this.tooltip.offsetHeight - 8));
    this.tooltip.style.left = left + 'px';
    this.tooltip.style.top = top + 'px';
    this.tooltipAnchor = {
      left,
      right: left + this.tooltip.offsetWidth,
      y: top + this.tooltip.offsetHeight / 2,
    };
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
    if (after.x - before.x > this.gapLimit) return null;
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
    const { minTime, maxTime } = this.getZoomedRange();
    const zoomedPoints = this.points.filter(point => point.timestamp >= minTime && point.timestamp <= maxTime);
    const available = this.series.filter(series => this.visibleSeries.has(series.path)).flatMap(series =>
      zoomedPoints
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

    let max = this.options.max || Math.max(1, ...available) * 1.12;
    let yTicks = [0, 1, 2, 3, 4].map(line => max * line / 4);
    if (this.options.discrete) {
      const observedMax = Math.max(1, Math.ceil(Math.max(...available)));
      if (observedMax <= 8) {
        max = observedMax;
        yTicks = Array.from({ length: max + 1 }, (_, value) => value);
      } else {
        const step = Math.ceil(observedMax / 4);
        max = step * 4;
        yTicks = [0, step, step * 2, step * 3, max];
      }
    }
    const timeSpan = Math.max(1000, maxTime - minTime);
    const x = value => margin.left + ((value - minTime) / timeSpan) * plotWidth;
    const y = value => margin.top + plotHeight - (Math.max(0, value) / max) * plotHeight;

    const guideTimestamp = this.hoverTimestamp || this.focusTimestamp;
    if (guideTimestamp && guideTimestamp >= minTime && guideTimestamp <= maxTime) {
      const guideX = x(guideTimestamp);
      context.strokeStyle = '#172124';
      context.setLineDash([4, 4]);
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(guideX, margin.top);
      context.lineTo(guideX, margin.top + plotHeight);
      context.stroke();
      context.setLineDash([]);
      if (this.hoverTimestamp && !this.tooltip.hidden && this.tooltipAnchor) {
        const targetX = guideX <= this.tooltipAnchor.left ? this.tooltipAnchor.left : this.tooltipAnchor.right;
        context.strokeStyle = '#172124';
        context.setLineDash([2, 3]);
        context.beginPath();
        context.moveTo(guideX, this.tooltipAnchor.y);
        context.lineTo(targetX, this.tooltipAnchor.y);
        context.stroke();
        context.setLineDash([]);
      }
    }

    context.strokeStyle = grid;
    context.fillStyle = muted;
    context.font = '11px ui-monospace, monospace';
    context.lineWidth = 1;
    context.textAlign = 'right';
    yTicks.forEach(value => {
      const lineY = y(value);
      context.beginPath();
      context.moveTo(margin.left, lineY);
      context.lineTo(width - margin.right, lineY);
      context.stroke();
      context.fillText(this.options.percent ? `${value.toFixed(0)}%` : this.options.discrete ? String(value) : compact(value), margin.left - 8, lineY + 4);
    });

    context.textAlign = 'center';
    [0, 0.5, 1].forEach(position => {
      const timestamp = minTime + timeSpan * position;
      context.fillText(formatTime(timestamp), margin.left + plotWidth * position, height - 8);
    });

    this.series.forEach(series => {
      if (!this.visibleSeries.has(series.path)) return;
      const realPoints = zoomedPoints
        .map(point => ({ x: point.timestamp, y: Number(pick(point, series.path)), real: true }))
        .filter(point => Number.isFinite(point.y));
      if (!realPoints.length) return;
      context.strokeStyle = series.color;
      context.lineWidth = 2;
      context.lineJoin = 'round';
      const segments = this.options.discrete || !this.bridgeGaps
        ? splitAtGaps(realPoints, this.gapLimit)
        : [realPoints];
      segments.forEach(segment => {
        const displayPoints = this.options.discrete ? segment : interpolate(segment, this.subdivisions);
        context.beginPath();
        if (this.options.discrete) {
          context.moveTo(x(displayPoints[0].x), y(displayPoints[0].y));
          displayPoints.slice(1).forEach((point, index) => {
            const previous = displayPoints[index];
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
      });

      context.fillStyle = series.color;
      realPoints.forEach(point => {
        context.beginPath();
        context.arc(x(point.x), y(point.y), 2.5, 0, Math.PI * 2);
        context.fill();
      });
    });

    if (this.zoomLevel > 1.01) {
      context.fillStyle = muted;
      context.font = '10px ui-monospace, monospace';
      context.textAlign = 'left';
      context.fillText(`\u00d7${this.zoomLevel.toFixed(1)} zoom`, margin.left + 4, margin.top + 12);
    }
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
