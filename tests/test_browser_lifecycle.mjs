import assert from 'node:assert/strict';
import test from 'node:test';

import { needsHistoryReload, selectTimeWindow } from '../dashboard/js/history.js';
import { installResumeListeners } from '../dashboard/js/lifecycle.js';

test('thirty-minute hidden-tab throttle resumes through the production listener seam', async () => {
  const documentTarget = new EventTarget();
  const windowTarget = new EventTarget();
  documentTarget.hidden = true;
  const history = [{ timestamp: 1_000, status: 'ok' }, { timestamp: 2_000, status: 'ok' }];
  const serverHistory = [{ timestamp: 1_802_000, status: 'ok' }, { timestamp: 1_803_000, status: 'ok' }];
  let rendered = history;
  const events = [];
  const uninstall = installResumeListeners(documentTarget, windowTarget, event => {
    events.push(event);
    if (needsHistoryReload(rendered, serverHistory.at(-1), 5_000)) rendered = serverHistory;
  });

  documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(events, []);
  documentTarget.hidden = false;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.deepEqual(events, ['visibilitychange']);
  assert.deepEqual(selectTimeWindow(rendered, 0, 60).map(point => point.timestamp), [1_802_000, 1_803_000]);

  uninstall();
  windowTarget.dispatchEvent(new Event('focus'));
  assert.deepEqual(events, ['visibilitychange']);
});
