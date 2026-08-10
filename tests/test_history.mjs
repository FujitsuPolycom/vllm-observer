import assert from 'node:assert/strict';
import test from 'node:test';

import { needsHistoryReload, normalizeHistory, selectTimeWindow } from '../dashboard/js/history.js';

test('a snapshot after a background gap requires authoritative history reload', () => {
  const history = [
    { timestamp: 1_000, status: 'ok' },
    { timestamp: 2_000, status: 'ok' },
  ];
  assert.equal(needsHistoryReload(history, { timestamp: 1_802_000, status: 'ok' }, 5_000), true);
  assert.equal(needsHistoryReload(history, { timestamp: 3_000, status: 'ok' }, 5_000), false);
});

test('a thirty-minute browser throttle gap triggers recovery', () => {
  const history = [{ timestamp: 1_000, status: 'ok' }, { timestamp: 2_000, status: 'ok' }];
  const resumed = { timestamp: 1_802_000, status: 'ok' };
  assert.equal(needsHistoryReload(history, resumed, 5_000), true);
  assert.deepEqual(selectTimeWindow([...history, resumed], 0, 60).map(point => point.timestamp), [1_802_000]);
});

test('one-minute window never includes stale points across a background gap', () => {
  const history = [
    { timestamp: 1_000 },
    { timestamp: 2_000 },
    { timestamp: 1_802_000 },
    { timestamp: 1_803_000 },
  ];
  assert.deepEqual(
    selectTimeWindow(history, 0, 60).map(point => point.timestamp),
    [1_802_000, 1_803_000],
  );
});

test('server history is sorted, deduplicated, and bounded', () => {
  const points = normalizeHistory([
    { timestamp: 3, status: 'ok' },
    { timestamp: 1, status: 'ok' },
    { timestamp: 3, status: 'ok', marker: 'newest' },
    { timestamp: 2, status: 'error' },
  ], 2);
  assert.deepEqual(points.map(point => point.timestamp), [1, 3]);
  assert.equal(points.at(-1).marker, 'newest');
});
