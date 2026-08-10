import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChanged, shouldAutoReload } from '../dashboard/js/build.js';

test('a new concrete commit is detected without looping on unknown metadata', () => {
  assert.equal(buildChanged('abc123', 'def456'), true);
  assert.equal(buildChanged('abc123', 'abc123'), false);
  assert.equal(buildChanged('unknown', 'def456'), false);
  assert.equal(buildChanged('abc123', 'unknown'), false);
});

test('live dashboards auto-reload while paused or pinned dashboards preserve state', () => {
  assert.equal(shouldAutoReload({ hidden: false, paused: false, pinned: false }), true);
  assert.equal(shouldAutoReload({ hidden: true, paused: false, pinned: false }), false);
  assert.equal(shouldAutoReload({ hidden: false, paused: true, pinned: false }), false);
  assert.equal(shouldAutoReload({ hidden: false, paused: false, pinned: true }), false);
});
