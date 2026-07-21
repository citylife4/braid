import net from 'node:net';
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import {
  T, FrameParser, encodeHello, encodeOpen, encodePing, encodePong,
  readStreamId, decodeOpenErr, decodeData, decodeSeq,
} from './frame.js';
import { StreamEngine } from './stream-engine.js';

const RECONNECT_MS = 2000;
// Fast pings do double duty: they measure each subflow's round-trip time for
// the scheduler, and they catch a silently-dead subflow (USB Wi-Fi adapter
// reset, powerline dropout) in seconds instead of half a minute.
const PING_MS = 2000;
const DEAD_MS = 7000;
const LINGER_MS = 10000;
const DEFAULT_RTT = 50; // ms, until the first pong lands

// Map a server-reported OPEN_ERR code to a Node-style error code so the
// proxy's existing SOCKS/HTTP error mapping keeps working unchanged.
const CODE_TO_ERR = { 3: 'ENETUNREACH', 4: 'EHOSTUNREACH', 5: 'ECONNREFUSED' };

function objErr(message, code) {
  return Object.assign(new Error(message), { code });
}

// A single app connection tunnelled over the bond. The proxy pipes the app
// socket to/from this duplex; the StreamEngine spreads it across subflows.
class TunnelStream extends Duplex {
  constructor(tunnel, id) {
    super();
    this.id = id;
    this.tunnel = tunnel;
    this.writeCb = null;
    this.engine = new StreamEngine(id, {
      send: (frame, avoid) => tunnel._send(frame, avoid),
      onDeliver: (payload) => this.push(payload),
      onFinDelivered: () => this.push(null),
      onReset: () => this.destroy(new Error('stream reset by peer')),
      onWindow: () => {
        const cb = this.writeCb;
        this.writeCb = null;
        cb?.();
      },
    });
  }
  _write(chunk, _enc, cb) {
    this.engine.write(chunk);
    if (this.engine.canSend()) cb();
    else this.writeCb = cb; // backpressure: resume when the window frees
  }
  _final(cb) {
    this.engine.finish();
    cb();
  }
  _read() {
    this.engine.resumeDelivery();
  }
  _destroy(err, cb) {
    if (err) this.engine.reset();
    cb(err);
  }
}

export class TunnelClient {
  constructor(manager, { host, port, secret = '', log }) {
    this.manager = manager;
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.log = log;
    this.tunnelId = randomBytes(16);
    this.subflows = new Map(); // linkName -> subflow
    this.engines = new Map(); // streamId -> StreamEngine
    this.streams = new Map(); // streamId -> TunnelStream
    this.opening = new Map(); // streamId -> { resolve, reject }
    this.pending = []; // frames waiting for a ready subflow
    this.readyWaiters = [];
    this.reconnects = new Set(); // pending subflow reconnect timers
    this.nextId = 1;
    this.streamCount = 0;
    this.timer = null;
    this.closed = false;
  }

  start() {
    for (const link of this.manager.healthy()) this.openSubflow(link);
    // Named handlers so stop() can detach them — the GUI can reconfigure the
    // bonding server at runtime, which replaces this client with a new one.
    this.handlers = {
      up: (link) => this.openSubflow(link),
      added: (link) => this.openSubflow(link),
      down: (link) => this.closeSubflow(link.name),
    };
    this.manager.on('up', this.handlers.up);
    this.manager.on('added', this.handlers.added);
    this.manager.on('down', this.handlers.down);
    this.timer = setInterval(() => this.tick(), 500);
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer);
    if (this.handlers) {
      this.manager.off('up', this.handlers.up);
      this.manager.off('added', this.handlers.added);
      this.manager.off('down', this.handlers.down);
      this.handlers = null;
    }
    for (const timer of this.reconnects) clearTimeout(timer);
    this.reconnects.clear();
    for (const sf of this.subflows.values()) sf.socket.destroy();
    for (const stream of [...this.streams.values()]) stream.destroy();
    for (const engine of this.engines.values()) engine.destroy();
    this.engines.clear();
  }

  readyCount() {
    let n = 0;
    for (const sf of this.subflows.values()) if (sf.ready) n += 1;
    return n;
  }

  openSubflow(link) {
    if (this.closed || this.subflows.has(link.name)) return;
    let socket;
    try {
      // A loopback server (local testing) is unreachable from a LAN-bound
      // source address, so only bind to the link for real remote servers.
      const loopback = this.host === 'localhost' || this.host === '::1' || this.host.startsWith('127.');
      socket = net.connect({ host: this.host, port: this.port, localAddress: loopback ? undefined : link.address, noDelay: true });
    } catch (err) {
      this.log.debug(`tunnel: subflow via ${link.name} failed to start: ${err.message}`);
      return;
    }
    const sf = { socket, link, ready: false, parser: new FrameParser(), lastPong: Date.now(), lastPing: 0, pingSentAt: 0, srtt: null };
    this.subflows.set(link.name, sf);
    socket.on('connect', () => socket.write(encodeHello(this.tunnelId, this.secret)));
    socket.on('data', (chunk) => {
      link.bytesIn += chunk.length;
      try {
        sf.parser.push(chunk, (type, body) => this.onFrame(sf, type, body));
      } catch (err) {
        this.log.debug(`tunnel: bad frame from server via ${link.name}: ${err.message}`);
        socket.destroy();
      }
    });
    socket.on('drain', () => this.drainPending());
    socket.on('error', () => {});
    socket.on('close', () => this.onSubflowClose(sf));
  }

  onSubflowClose(sf) {
    if (this.subflows.get(sf.link.name) === sf) this.subflows.delete(sf.link.name);
    const wasReady = sf.ready;
    sf.ready = false;
    if (wasReady) {
      this.log.warn(`tunnel: subflow via ${sf.link.name} dropped — retransmitting its in-flight data`);
      for (const engine of this.engines.values()) engine.retransmitFor(sf.link.name);
    }
    // Reconnect while the link is still considered up.
    if (this.closed) return;
    const timer = setTimeout(() => {
      this.reconnects.delete(timer);
      const link = this.manager.links.find((l) => l.name === sf.link.name);
      if (link && link.up && link.enabled) this.openSubflow(link);
    }, RECONNECT_MS);
    this.reconnects.add(timer);
  }

  closeSubflow(name) {
    const sf = this.subflows.get(name);
    if (sf) sf.socket.destroy();
  }

  onFrame(sf, type, body) {
    switch (type) {
      case T.HELLO_OK:
        sf.ready = true;
        sf.lastPong = Date.now();
        this.log.info(`tunnel: subflow up via ${sf.link.name} (${sf.link.address})`);
        this.resolveReady();
        this.drainPending();
        break;
      case T.PONG:
        sf.lastPong = Date.now();
        if (sf.pingSentAt) {
          // Pongs queue behind bulk data on a congested subflow, so this
          // sample doubles as a queue-delay signal for the scheduler.
          const sample = sf.lastPong - sf.pingSentAt;
          sf.srtt = sf.srtt == null ? sample : Math.round(sf.srtt * 0.75 + sample * 0.25);
          sf.pingSentAt = 0;
        }
        break;
      case T.PING:
        sf.socket.write(encodePong());
        break;
      case T.OPEN_OK: {
        const w = this.opening.get(readStreamId(body));
        w?.resolve();
        break;
      }
      case T.OPEN_ERR: {
        const { streamId, code } = decodeOpenErr(body);
        this.opening.get(streamId)?.reject(objErr('target refused', CODE_TO_ERR[code] ?? 'EIO'));
        break;
      }
      case T.DATA: {
        const { streamId, seq, payload } = decodeData(body);
        this.engines.get(streamId)?.dataReceived(seq, payload);
        break;
      }
      case T.ACK: {
        const { streamId, seq } = decodeSeq(body);
        this.engines.get(streamId)?.ackReceived(seq);
        break;
      }
      case T.FIN: {
        const { streamId, seq } = decodeSeq(body);
        this.engines.get(streamId)?.finReceived(seq);
        break;
      }
      case T.RESET: {
        this.engines.get(readStreamId(body))?.reset(false);
        break;
      }
      default:
        break;
    }
  }

  // Latency- and queue-aware subflow choice: prefer the link whose socket is
  // least backed up AND answers pings fastest, scaled by the user's weight.
  // This is what turns one stream into N links of throughput while keeping a
  // slow or congested link from hoarding frames it cannot deliver in time.
  // `avoid` skips a subflow (the one being retransmitted away from) unless it
  // is the only one left.
  pickSubflow(forData = true, avoid = null) {
    let best = null;
    let bestScore = Infinity;
    let fallback = null;
    for (const sf of this.subflows.values()) {
      if (!sf.ready) continue;
      const rtt = Math.max(sf.srtt ?? DEFAULT_RTT, 5);
      const score = (sf.socket.writableLength + 1) * rtt / (forData ? (sf.link.weight || 1) : 1);
      if (sf.link.name === avoid) {
        fallback = sf;
        continue;
      }
      if (score < bestScore) {
        bestScore = score;
        best = sf;
      }
    }
    return best ?? fallback;
  }

  _send(frame, avoid = null) {
    // Control frames (ACKs, opens, resets) are tiny and latency-critical:
    // route them by pure responsiveness, not by data-spreading weight.
    const sf = this.pickSubflow(frame[4] === T.DATA, avoid);
    if (!sf) {
      this.pending.push(frame);
      return null;
    }
    sf.socket.write(frame);
    sf.link.bytesOut += frame.length;
    return sf.link.name;
  }

  drainPending() {
    if (!this.pending.length) return;
    const queue = this.pending;
    this.pending = [];
    for (const frame of queue) this._send(frame);
  }

  ready(timeout = 4000) {
    if (this.readyCount()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w.timer !== timer);
        reject(objErr('no tunnel subflows available', 'ENOLINK'));
      }, timeout);
      this.readyWaiters.push({ resolve, timer });
    });
  }

  resolveReady() {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  async open(host, port) {
    await this.ready();
    const id = this.nextId++;
    const stream = new TunnelStream(this, id);
    this.engines.set(id, stream.engine);
    this.streams.set(id, stream);
    this.streamCount += 1;
    stream.once('close', () => {
      this.streams.delete(id);
      this.streamCount -= 1;
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.opening.delete(id);
          reject(objErr('tunnel open timed out', 'ETIMEDOUT'));
        }, 15000);
        this.opening.set(id, {
          resolve: () => { clearTimeout(timer); this.opening.delete(id); resolve(); },
          reject: (err) => { clearTimeout(timer); this.opening.delete(id); reject(err); },
        });
        this._send(encodeOpen(id, host, port));
      });
    } catch (err) {
      this.engines.delete(id);
      stream.destroy();
      throw err;
    }
    return { socket: stream, link: null, tracked: false };
  }

  tick() {
    const now = Date.now();
    for (const sf of this.subflows.values()) {
      if (!sf.ready) continue;
      if (now - sf.lastPong > DEAD_MS) {
        this.log.warn(`tunnel: subflow via ${sf.link.name} unresponsive — recycling`);
        sf.socket.destroy();
        continue;
      }
      if (now - sf.lastPing >= PING_MS) {
        sf.lastPing = now;
        if (!sf.pingSentAt) sf.pingSentAt = now; // keep the oldest unanswered ping
        sf.socket.write(encodePing());
      }
    }
    for (const [id, engine] of this.engines) {
      engine.tick(now);
      if (engine.isFinished()) {
        if (!engine.doneAt) engine.doneAt = now;
        else if (now - engine.doneAt > LINGER_MS) {
          engine.destroy();
          this.engines.delete(id);
        }
      }
    }
  }

  status() {
    return {
      enabled: true,
      server: `${this.host}:${this.port}`,
      subflows: this.readyCount(),
      total: this.subflows.size,
      streams: this.streamCount,
      links: [...this.subflows.values()].map((sf) => ({
        link: sf.link.name,
        ready: sf.ready,
        rtt: sf.srtt,
      })),
    };
  }
}
