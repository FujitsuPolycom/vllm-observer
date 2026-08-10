export function buildChanged(current, incoming) {
  return Boolean(current && incoming && current !== 'unknown' && incoming !== 'unknown' && current !== incoming);
}

export function shouldAutoReload({ hidden, paused, pinned }) {
  return !hidden && !paused && !pinned;
}
