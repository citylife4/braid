import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Resolver, lookup } from 'node:dns/promises';

// Health checks rotate across independent anycast targets so an outage of a
// single target is never mistaken for a dead link.
const CHECK_TARGETS = [
  { host: '1.1.1.1', port: 443 },
  { host: '8.8.8.8', port: 443 },
  { host: '9.9.9.9', port: 443 },
];
// Braid resolves names through sockets bound to a physical link. This keeps
// DNS working (and loop-free) when system-wide capture owns the default route.
const DNS_SERVERS = ['1.1.1.1', '8.8.8.8'];
const DOWN_AFTER_FAILURES = 2;
const HISTORY_LENGTH = 120;

export const STRATEGIES = ['balanced', 'least-busy', 'failover'];

export function discoverInterfaces() {
  const found = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (name === 'braid') continue; // never bond our own capture adapter
    for (const addr of addresses ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // link-local: no internet
      if (addr.address.startsWith('192.168.123.')) continue; // capture adapter subnet
      found.push({ name, address: addr.address, mac: addr.mac });
    }
  }
  return found;
}

function makeResolver(address) {
  const resolver = new Resolver({ timeout: 2500, tries: 2 });
  resolver.setServers(DNS_SERVERS);
  try {
    resolver.setLocalAddress(address);
  } catch {
    // keep an unbound resolver rather than none at all
  }
  return resolver;
}

export class LinkManager extends EventEmitter {
  constructor(defs, { checkInterval = 5000, checkTimeout = 3000, strategy = 'balanced' } = {}) {
    super();
    this.checkInterval = checkInterval;
    this.checkTimeout = checkTimeout;
    this.strategy = strategy;
    this.startedAt = Date.now();
    this.events = [];
    this.timers = [];
    this.links = defs.map((def, index) => ({
      index,
      name: def.name,
      address: def.address,
      weight: def.weight ?? 1,
      pinned: def.pinned ?? false, // pinned = user gave a raw IP, never auto-update it
      enabled: true,
      up: true,
      latency: null,
      failures: 0,
      checking: false,
      targetIndex: index % CHECK_TARGETS.length,
      current: 0, // smooth weighted round-robin state
      active: 0,
      total: 0,
      udpFlows: 0,
      bytesIn: 0,
      bytesOut: 0,
      rateIn: 0,
      rateOut: 0,
      lastBytesIn: 0,
      lastBytesOut: 0,
      history: [],
      sockets: new Set(),
      resolver: makeResolver(def.address),
    }));
  }

  start() {
    for (const link of this.links) {
      const stagger = (this.checkInterval / this.links.length) * link.index;
      this.timers.push(setTimeout(() => {
        this.check(link);
        this.timers.push(setInterval(() => this.check(link), this.checkInterval));
      }, stagger));
    }
    this.timers.push(setInterval(() => this.tick(), 1000));
    this.timers.push(setInterval(() => this.refreshAddresses(), 30000));
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  check(link) {
    if (link.checking) return;
    link.checking = true;
    const target = CHECK_TARGETS[link.targetIndex];
    link.targetIndex = (link.targetIndex + 1) % CHECK_TARGETS.length;
    const started = Date.now();

    let socket;
    let timer;
    let settled = false;
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      link.checking = false;
      socket?.destroy();
      if (ok) {
        link.latency = Date.now() - started;
        this.noteSuccess(link);
      } else {
        link.latency = null;
        this.noteFailure(link, detail);
      }
    };

    try {
      socket = net.connect({ host: target.host, port: target.port, localAddress: link.address });
    } catch (err) {
      finish(false, `health check failed (${err.code ?? err.message})`);
      return;
    }
    timer = setTimeout(() => finish(false, `health check timed out via ${target.host}`), this.checkTimeout);
    socket.once('connect', () => finish(true));
    socket.on('error', (err) => finish(false, `health check failed via ${target.host} (${err.code ?? err.message})`));
  }

  noteSuccess(link) {
    link.failures = 0;
    if (!link.up) {
      link.up = true;
      this.record('up', `${link.name} is back up`);
      this.emit('up', link);
    }
  }

  noteFailure(link, detail) {
    link.failures += 1;
    if (link.up && link.failures >= DOWN_AFTER_FAILURES) {
      link.up = false;
      this.record('down', `${link.name} is down (${detail})`);
      this.emit('down', link);
      this.dropSockets(link, `link ${link.name} went down`);
    }
  }

  // Connections on a dead or disabled link are useless; kill them fast so
  // applications retry immediately over the remaining links.
  dropSockets(link, reason) {
    for (const socket of [...link.sockets]) {
      socket.destroy(new Error(reason));
    }
  }

  track(link, socket) {
    link.active += 1;
    link.total += 1;
    link.sockets.add(socket);
    socket.once('close', () => {
      link.active -= 1;
      link.sockets.delete(socket);
    });
  }

  trackUdp(link) {
    link.udpFlows += 1;
  }

  untrackUdp(link) {
    link.udpFlows -= 1;
  }

  setStrategy(strategy) {
    if (!STRATEGIES.includes(strategy)) {
      return { ok: false, error: `strategy must be one of: ${STRATEGIES.join(', ')}` };
    }
    if (strategy !== this.strategy) {
      this.strategy = strategy;
      this.record('info', `strategy changed to "${strategy}"`);
    }
    return { ok: true, strategy };
  }

  toggleLink(name) {
    const link = this.links.find((l) => l.name === name);
    if (!link) return { ok: false, error: `no such link "${name}"` };
    if (link.enabled && this.links.filter((l) => l.enabled).length === 1) {
      return { ok: false, error: 'cannot disable the last enabled link' };
    }
    link.enabled = !link.enabled;
    this.record('info', `${link.name} ${link.enabled ? 'enabled' : 'disabled'} by user`);
    if (!link.enabled) this.dropSockets(link, `link ${link.name} disabled`);
    return { ok: true, name: link.name, enabled: link.enabled };
  }

  // Resolve through a healthy link's own resolver (bound to that interface),
  // falling back to the system resolver for hosts-file / intranet names.
  async resolveHost(host) {
    for (const link of this.links) {
      if (!link.up || !link.enabled) continue;
      try {
        const answers = await link.resolver.resolve4(host);
        if (answers.length) return answers[0];
      } catch {
        // try the next link
      }
    }
    return (await lookup(host, { family: 4 })).address;
  }

  tick() {
    for (const link of this.links) {
      link.rateIn = link.bytesIn - link.lastBytesIn;
      link.rateOut = link.bytesOut - link.lastBytesOut;
      link.lastBytesIn = link.bytesIn;
      link.lastBytesOut = link.bytesOut;
      link.history.push({ i: link.rateIn, o: link.rateOut });
      if (link.history.length > HISTORY_LENGTH) link.history.shift();
    }
  }

  // DHCP can hand an interface a new address after it reconnects; follow it
  // by interface name so the link keeps working without a restart.
  refreshAddresses() {
    const current = discoverInterfaces();
    for (const link of this.links) {
      if (link.pinned) continue;
      const match = current.find((iface) => iface.name === link.name);
      if (match && match.address !== link.address) {
        this.record('info', `${link.name} address changed ${link.address} -> ${match.address}`);
        link.address = match.address;
        link.resolver = makeResolver(match.address);
      }
    }
  }

  healthy() {
    return this.links.filter((link) => link.up && link.enabled);
  }

  record(kind, message) {
    this.events.push({ at: Date.now(), kind, message });
    if (this.events.length > 100) this.events.shift();
  }

  stats() {
    return {
      startedAt: this.startedAt,
      strategy: this.strategy,
      links: this.links.map((l) => ({
        name: l.name,
        address: l.address,
        weight: l.weight,
        enabled: l.enabled,
        up: l.up,
        latency: l.latency,
        active: l.active,
        total: l.total,
        udpFlows: l.udpFlows,
        bytesIn: l.bytesIn,
        bytesOut: l.bytesOut,
        rateIn: l.rateIn,
        rateOut: l.rateOut,
        history: l.history,
      })),
      events: this.events.slice().reverse(),
    };
  }
}
