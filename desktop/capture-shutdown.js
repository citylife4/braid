export function captureIsPresent(capture) {
  return Boolean(capture?.engineRunning || capture?.adapterUp);
}

export function captureShutdownAction(capture) {
  if (!captureIsPresent(capture)) return 'none';
  if (capture.ownership === 'other') return 'leave';
  if (capture.ownership === 'this' || capture.ownership === 'orphaned') return 'disable';
  return 'manual';
}

export function captureStartupAction(capture) {
  if (!captureIsPresent(capture)) return 'enable';
  if (capture?.active && capture.ownership === 'this') return 'ready';
  if (capture?.ownership === 'other') return 'leave';
  return 'manual';
}
