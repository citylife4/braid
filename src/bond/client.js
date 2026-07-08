import net from 'node:net';
import crypto from 'node:crypto';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import {
  T, VERSION,
  encodeFrame, jsonFrame, createFrameParser,
  decodeData, decodeAck, decodeClose,
} from './protocol.js';
import { Channel } from './channel.js';

const RECONNECT_MIN = 1000;
const RECONNECT_MAX = 15000;
const PING_INTERVAL = 10000;
const OPEN_TIMEOUT = 12000;

// Client side of the bonding tunnel. Holds one member connection per physical
// link to the braid-server, all sharing one session id. Application streams are
// multiplexed across every live member and reassembled at the server, so a
// single stream's throughput adds up across links.
//
// openStream(host, port) resolves, once the server has connected to the target,
// to a Duplex the proxy pipes the app socket through.
export class BondClient extends EventEmitter {
  constructor({ host, port, key, manager, log }) {
    super();
    this.serverHost = host;
    this.serverPort = port;
    this.key = key;
    this.manager = manager;
    this.log = log;
    this.sessionId = crypto.randomUUID();
    this.members = new Map(); // link.name -> member
    this.streams = new Map(); // streamId -> { channel, duplex, pending }
    this.nextStream = 1;
    this.closed = false;
  }

  start() {
    for (const link of this.manager.links) this.ensureMember(link);
    // Track links appearing/disappearing (hot-plug from v2).
    this.manager.on('added', (link) => this.ensureMember(link));
    this.manager.on('up', (link) => this.ensureMember(link));
    this.manager.on('down', (link) => this.members.get(link.name)?.socket?.destroy());
    this._pinger = setInterval(() => this.pingAll(), PING_INTERVAL);
  }

  stop() {
    this.closed = true;
    clearInterval(this._pinger);
    for (const m of this.members.values()) { clearTimeout(m.retryTimer); m.socket?.destroy(); }
    this.members.clear();
  }

  liveMembers() {
    return [...this.members.values()].filter((m) => m.ready);
  }

  ready() {
    return this.liveMembers().length > 0;
  }

  ensureMember(link) {
    let member = this.members.get(link.name);
    if (!member) {
      member = { link, socket: null, ready: false, weight: link.weight, current: 0, backoff: RECONNECT_MIN, retryTimer: null };
      this.members.set(link.name, member);
    }
    if (member.socket || this.closed) return;
    this.connectMember(member);
  }

  connectMember(member) {
    const link = member.link;
    let socket;
    try {
      socket = net.connect({ host: this.serverHost, port: this.serverPort, localAddress: link.address, noDelay: true });
    } catch {
      member.socket = null;
      this.scheduleReconnect(member);
      return;
    }
    member.socket = socket;
    const parse = createFrameParser((type, body) => this.onFrame(member, type, body), () => socket.destroy());

    socket.once('connect', () => {
      socket.write(jsonFrame(T.HELLO, {
        v: VERSION, session: this.sessionId, link: link.name, weight: link.weight, key: this.key,
      }));
    });
    socket.on('data', parse);
    socket.on('error', () => {});
    socket.on('close', () => {
      const wasReady = member.ready;
      member.ready = false;
      member.socket = null;
      if (wasReady) {
        this.log.warn(`bond: member ${link.name} disconnected`);
        // Retransmit this member's inflight bytes over the survivors.
        for (const { channel } of this.streams.values()) channel.onMemberDown(link.name);
      }
      this.scheduleReconnect(member);
    });
  }

  scheduleReconnect(member) {
    if (this.closed) return;
    clearTimeout(member.retryTimer);
    const delay = member.backoff;
    member.backoff = Math.min(member.backoff * 2, RECONNECT_MAX);
    member.retryTimer = setTimeout(() => {
      if (!this.closed && this.members.get(member.link.name) === member && !member.socket) this.connectMember(member);
    }, delay);
  }

  onFrame(member, type, body) {
    switch (type) {
      case T.HELLO_OK: {
        let ok;
        try { ok = JSON.parse(body.toString('utf8')); } catch { member.socket.destroy(); return; }
        if (!ok.ok) {
          this.log.error(`bond: server rejected member ${member.link.name}: ${ok.error || 'unknown'} (does --bond-key match the server?)`);
          member.socket.destroy();
          return;
        }
        member.ready = true;
        member.backoff = RECONNECT_MIN;
        this.log.info(`bond: member ${member.link.name} joined session ${this.sessionId.slice(0, 8)}`);
        this.emit('member-up', member.link);
        for (const { channel } of this.streams.values()) channel.flush();
        break;
      }
      case T.OPEN_OK: {
        let o;
        try { o = JSON.parse(body.toString('utf8')); } catch { return; }
        const s = this.streams.get(o.stream);
        if (!s || !s.pending) return;
        const { resolve, reject, timer } = s.pending;
        s.pending = null;
        clearTimeout(timer);
        if (o.ok) {
          resolve(s.duplex);
        } else {
          this.streams.delete(o.stream);
          s.duplex.destroy();
          reject(Object.assign(new Error(`bond open failed (${o.code || 'EFAIL'})`), { code: o.code || 'EFAIL' }));
        }
        break;
      }
      case T.DATA: {
        const { stream, offset, payload } = decodeData(body);
        member.link.bytesIn += payload.length;
        this.streams.get(stream)?.channel.onData(offset, payload);
        break;
      }
      case T.ACK: {
        const { stream, ackOffset } = decodeAck(body);
        this.streams.get(stream)?.channel.onAck(ackOffset);
        break;
      }
      case T.CLOSE: {
        const { stream, flag, finalOffset } = decodeClose(body);
        this.streams.get(stream)?.channel.onClose(flag, finalOffset);
        break;
      }
      case T.PONG:
        member.lastPong = Date.now();
        break;
      default:
        break;
    }
  }

  // Spread each frame across live members (smooth weighted round-robin).
  // DATA goodput is accounted to the chosen link for the dashboard.
  schedule(frame) {
    const live = this.liveMembers();
    if (!live.length) return null;
    let total = 0;
    let best = null;
    for (const m of live) { m.current += m.weight; total += m.weight; if (!best || m.current > best.current) best = m; }
    best.current -= total;
    best.socket.write(frame);
    if (frame[0] === T.DATA) best.link.bytesOut += frame.length - 15;
    return best.link.name;
  }

  openStream(host, port) {
    return new Promise((resolve, reject) => {
      if (!this.ready()) {
        reject(Object.assign(new Error('no bond members connected'), { code: 'ENOLINK' }));
        return;
      }
      const streamId = this.nextStream;
      this.nextStream = ((this.nextStream + 1) & 0x7fffffff) || 1;

      const channel = new Channel(streamId, {
        schedule: (frame) => this.schedule(frame),
        deliver: (buf) => duplex.push(buf),
      });
      const duplex = new Duplex({
        read() {},
        write: (chunk, _enc, cb) => { if (channel.write(chunk)) cb(); else channel.once('drain', cb); },
        final: (cb) => { channel.end(); cb(); },
        destroy: (err, cb) => { if (err) channel.reset(); this.streams.delete(streamId); cb(err); },
      });
      channel.on('remote-end', () => duplex.push(null));       // read side EOF
      channel.on('remote-reset', () => duplex.destroy(new Error('bond stream reset by peer')));

      const timer = setTimeout(() => {
        const s = this.streams.get(streamId);
        if (s?.pending) {
          s.pending = null;
          this.streams.delete(streamId);
          duplex.destroy();
          reject(Object.assign(new Error('bond open timeout'), { code: 'ETIMEDOUT' }));
        }
      }, OPEN_TIMEOUT);

      this.streams.set(streamId, { channel, duplex, pending: { resolve, reject, timer } });
      this.schedule(jsonFrame(T.OPEN, { stream: streamId, host, port }));
    });
  }

  pingAll() {
    const stamp = Buffer.allocUnsafe(6);
    stamp.writeUIntLE(Date.now() % 0xffffffffffff, 0, 6);
    for (const m of this.liveMembers()) m.socket.write(encodeFrame(T.PING, stamp));
  }

  status() {
    return {
      server: `${this.serverHost}:${this.serverPort}`,
      session: this.sessionId.slice(0, 8),
      ready: this.ready(),
      members: [...this.members.values()].map((m) => ({ link: m.link.name, ready: m.ready })),
      activeStreams: this.streams.size,
    };
  }
}
