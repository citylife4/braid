import net from 'node:net';

// Errors that mean "this link could not carry the connection" - worth
// retrying on another link. Anything else (ECONNREFUSED, DNS failure) is a
// real answer from the network and must be reported to the client as-is.
const LINK_ERROR_CODES = new Set([
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'EINVAL',
]);

function poolFor(manager, excluded) {
  const healthy = manager.links.filter((l) => l.up && l.enabled && !excluded.has(l));
  if (healthy.length) return healthy;
  // Last resort: the health checker might be wrong, try "down" links too.
  return manager.links.filter((l) => l.enabled && !excluded.has(l));
}

// The picker consults manager.strategy on every call, so the GUI can switch
// strategies at runtime without a restart.
export function createPicker(manager) {
  return (excluded = new Set()) => {
    const pool = poolFor(manager, excluded);
    if (!pool.length) return null;

    if (manager.strategy === 'failover') return pool[0];

    // "adaptive": favor links that are fast (low health-check latency) and
    // lightly loaded, scaled by weight. An unstable or slow link naturally
    // receives fewer new connections without the user tuning anything.
    if (manager.strategy === 'adaptive') {
      let best = null;
      let bestScore = Infinity;
      for (const link of pool) {
        const latency = Math.max(link.latency ?? 80, 15);
        const score = ((link.active + 1) * latency) / (link.weight || 1);
        if (score < bestScore) {
          bestScore = score;
          best = link;
        }
      }
      return best;
    }

    if (manager.strategy === 'least-busy') {
      return pool.reduce((best, link) => (!best || link.active < best.active ? link : best), null);
    }

    // "balanced": smooth weighted round-robin (nginx algorithm).
    let totalWeight = 0;
    let best = null;
    for (const link of pool) {
      link.current += link.weight;
      totalWeight += link.weight;
      if (!best || link.current > best.current) best = link;
    }
    best.current -= totalWeight;
    return best;
  };
}

export async function dial(options, host, port, { timeout = 8000, onRetry } = {}) {
  const { manager, pick } = options;
  // Links bind IPv4 source addresses, so an IPv6 literal can never be dialed.
  // Refuse it up front rather than letting the EINVAL count as a link failure.
  if (net.isIP(host) === 6) {
    throw Object.assign(new Error('IPv6 targets are not supported'), { code: 'EAFNOSUPPORT' });
  }
  let address = host;
  if (!net.isIP(host)) {
    address = await manager.resolveHost(host); // throws ENOTFOUND etc. for the caller
  }

  const excluded = new Set();
  let lastError = null;
  for (;;) {
    const link = pick(excluded);
    if (!link) {
      throw lastError ?? Object.assign(new Error('no links available'), { code: 'ENOLINK' });
    }
    try {
      const socket = await connectVia(link.address, address, port, timeout);
      manager.noteSuccess(link);
      return { socket, link };
    } catch (err) {
      if (!LINK_ERROR_CODES.has(err.code)) throw err;
      manager.noteFailure(link, `dial ${host}:${port} failed (${err.code})`);
      excluded.add(link);
      lastError = err;
      onRetry?.(link, err);
    }
  }
}

function connectVia(localAddress, host, port, timeout) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = net.connect({ host, port, localAddress, noDelay: true });
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`connect to ${host}:${port} timed out`), { code: 'ETIMEDOUT' }));
    }, timeout);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
