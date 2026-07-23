import { api } from './api.js';
import { TimeSeriesChart } from './chart.js';
import {
  renderConfiguration,
  renderInstances,
  renderLogs,
  renderSnapshot,
  setConnection,
} from './render.js';

const element = id => document.getElementById(id);
const state = {
  instances: [],
  selected: '',
  history: [],
  paused: false,
  historyOffset: 0,
  chartOrder: loadChartOrder(),
};

function loadChartOrder() {
  const defaultOrder = ['throughput', 'decode', 'cache', 'requests'];
  try {
    const saved = JSON.parse(localStorage.getItem('vllm-observer:chart-order') || 'null');
    return Array.isArray(saved) && saved.length === defaultOrder.length && saved.every(name => defaultOrder.includes(name))
      ? saved
      : defaultOrder;
  } catch (error) {
    return defaultOrder;
  }
}

function saveChartOrder() {
  try { localStorage.setItem('vllm-observer:chart-order', JSON.stringify(state.chartOrder)); } catch (error) { /* optional preference */ }
}

function arrangeCharts() {
  const grid = document.querySelector('.chart-grid');
  const panels = new Map([...grid.querySelectorAll('[data-chart-panel]')].map(panel => [panel.dataset.chartPanel, panel]));
  state.chartOrder.forEach(name => { if (panels.has(name)) grid.appendChild(panels.get(name)); });
}

function moveChart(name, direction) {
  const index = state.chartOrder.indexOf(name);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= state.chartOrder.length) return;
  [state.chartOrder[index], state.chartOrder[next]] = [state.chartOrder[next], state.chartOrder[index]];
  arrangeCharts();
  saveChartOrder();
  Object.values(charts).forEach(chart => chart.draw());
}

function expandChart(panel, button) {
  const expanded = panel.classList.toggle('is-expanded');
  document.body.classList.toggle('chart-expanded', expanded);
  button.textContent = expanded ? 'Close' : 'Expand';
  button.setAttribute('aria-expanded', String(expanded));
  if (expanded) panel.querySelector('canvas')?.focus?.();
  Object.values(charts).forEach(chart => chart.draw());
}

function setupChartInteractions() {
  arrangeCharts();
  const grid = document.querySelector('.chart-grid');
  let draggedName = '';
  grid.querySelectorAll('[data-chart-panel]').forEach(panel => {
    const name = panel.dataset.chartPanel;
    panel.querySelectorAll('.chart-move').forEach(button => button.addEventListener('click', () => moveChart(name, button.dataset.direction === 'up' ? -1 : 1)));
    panel.querySelector('.chart-expand').addEventListener('click', event => expandChart(panel, event.currentTarget));
    panel.querySelector('.drag-handle').addEventListener('dragstart', event => {
      draggedName = name;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', name);
      panel.classList.add('is-dragging');
    });
    panel.querySelector('.drag-handle').addEventListener('dragend', () => {
      draggedName = '';
      panel.classList.remove('is-dragging');
      grid.querySelectorAll('.is-drop-target').forEach(target => target.classList.remove('is-drop-target'));
    });
    panel.addEventListener('dragover', event => {
      if (!draggedName || draggedName === name) return;
      event.preventDefault();
      panel.classList.add('is-drop-target');
    });
    panel.addEventListener('dragleave', () => panel.classList.remove('is-drop-target'));
    panel.addEventListener('drop', event => {
      event.preventDefault();
      panel.classList.remove('is-drop-target');
      const source = draggedName || event.dataTransfer.getData('text/plain');
      const from = state.chartOrder.indexOf(source);
      const to = state.chartOrder.indexOf(name);
      if (from < 0 || to < 0 || from === to) return;
      state.chartOrder.splice(from, 1);
      state.chartOrder.splice(to, 0, source);
      arrangeCharts();
      saveChartOrder();
      Object.values(charts).forEach(chart => chart.draw());
    });
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const expanded = document.querySelector('.chart-panel.is-expanded');
    if (expanded) expanded.querySelector('.chart-expand').click();
  });
}

const charts = {
  throughput: new TimeSeriesChart(element('throughputChart'), [
    { path: 'throughput.fresh_prefill_tps', color: '#12a594' },
    { path: 'throughput.cached_local_tps', color: '#de7b32' },
    { path: 'throughput.external_cache_tps', color: '#4c72d9' },
  ], { empty: 'Waiting for token counter changes' }),
  decode: new TimeSeriesChart(element('decodeChart'), [
    { path: 'throughput.decode_tps', color: '#d14f68' },
    { path: 'speculative.draft_tps', color: '#7d5fc4' },
    { path: 'speculative.accepted_tps', color: '#12a594' },
  ], { empty: 'Waiting for decode or MTP token changes' }),
  cache: new TimeSeriesChart(element('cacheChart'), [
    { path: 'cache.kv_usage_percent', color: '#12a594' },
    { path: 'cache.prefix_hit_percent', color: '#de7b32' },
    { path: 'cache.external_prefix_hit_percent', color: '#4c72d9' },
  ], { max: 100, percent: true, empty: 'Cache metrics are not exposed yet' }),
  requests: new TimeSeriesChart(element('requestChart'), [
    { path: 'requests.running', color: '#12a594' },
    { path: 'requests.waiting', color: '#d14f68' },
  ], { empty: 'Waiting for scheduler gauges' }),
};

async function loadInstances() {
  try {
    const payload = await api.instances();
    state.instances = payload.instances || [];
    const running = state.instances.find(item => item.running);
    if (!state.instances.some(item => item.name === state.selected)) {
      state.selected = running?.name || state.instances[0]?.name || '';
      await selectWorkload(state.selected);
    }
    renderInstances(state.instances, state.selected);
  } catch (error) {
    setConnection('error', 'Inventory error');
  }
}

async function selectWorkload(name) {
  state.selected = name;
  state.history = [];
  state.historyOffset = 0;
  renderInstances(state.instances, state.selected);
  if (!name) return;
  try {
    const [history, config, logs] = await Promise.all([
      api.history(name, 3600),
      api.config(name),
      api.logs(name),
    ]);
    state.history = history.points || [];
    renderConfiguration(config);
    renderLogs(logs);
    const point = state.history.at(-1) || await api.snapshot(name);
    renderSnapshot(point);
    drawCharts();
  } catch (error) {
    setConnection('error', 'Workload read failed');
    element('diagnostic').className = 'diagnostic error';
    element('diagnostic').textContent = error.message;
  }
}

async function loadSnapshot() {
  if (state.paused || !state.selected || document.hidden) return;
  try {
    const point = await api.snapshot(state.selected);
    renderSnapshot(point);
    if (point.status === 'ok' && !state.history.some(item => item.timestamp === point.timestamp)) {
      state.history.push(point);
      state.history = state.history.slice(-3600);
    }
    drawCharts();
    setConnection(point.status === 'ok' ? 'ok' : 'pending', point.status === 'ok' ? 'Live' : 'Waiting');
  } catch (error) {
    setConnection('error', 'API unavailable');
  }
}

async function loadLogs() {
  if (state.paused || !state.selected || document.hidden) return;
  try {
    renderLogs(await api.logs(state.selected));
  } catch (error) {
    element('logMeta').textContent = error.message;
  }
}

function drawCharts() {
  const windowSeconds = Number(element('windowSize').value);
  const maxOffset = Math.max(0, state.history.length - windowSeconds);
  state.historyOffset = Math.min(state.historyOffset, maxOffset);
  const end = state.history.length - state.historyOffset;
  const start = Math.max(0, end - windowSeconds);
  const visible = state.history.slice(start, end);
  const smoothness = Number(element('smoothness').value);
  Object.values(charts).forEach(chart => chart.update(visible, smoothness));

  const position = element('historyPosition');
  position.max = maxOffset;
  position.value = state.historyOffset;
  position.disabled = maxOffset === 0;
  element('historyPositionLabel').textContent = state.historyOffset
    ? `${state.historyOffset} real samples back`
    : 'Live edge';
  element('historyMeta').textContent = `${state.history.length} server-cached real samples · ${visible.length} displayed`;
}

element('instanceSelect').addEventListener('change', event => selectWorkload(event.target.value));
element('pauseButton').addEventListener('click', () => {
  state.paused = !state.paused;
  element('pauseButton').textContent = state.paused ? 'Resume' : 'Pause';
  setConnection(state.paused ? 'pending' : 'ok', state.paused ? 'Paused' : 'Live');
  if (!state.paused) loadSnapshot();
});
element('themeButton').addEventListener('click', () => {
  document.body.classList.toggle('minimal');
  element('themeButton').textContent = document.body.classList.contains('minimal') ? 'Rich' : 'Minimal';
  Object.values(charts).forEach(chart => chart.draw());
});
element('composeButton').addEventListener('click', () => {
  if (!state.selected) return;
  const link = document.createElement('a');
  link.href = `/api/compose?instance=${encodeURIComponent(state.selected)}`;
  link.click();
});
element('smoothness').addEventListener('input', event => {
  element('smoothnessValue').textContent = event.target.value;
  drawCharts();
});
element('windowSize').addEventListener('change', drawCharts);
element('historyPosition').addEventListener('input', event => {
  state.historyOffset = Number(event.target.value);
  drawCharts();
});

setupChartInteractions();
await loadInstances();
await loadSnapshot();
setInterval(loadSnapshot, 1000);
setInterval(loadLogs, 5000);
setInterval(loadInstances, 15000);
