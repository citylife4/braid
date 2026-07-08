import net from 'node:net';
import crypto from 'node:crypto';
import {
  T, FrameParser, encodeHelloOk, encodeOpenOk, encodeOpenErr, encodePong,
  readStreamId, decodeHello, decodeOpen, decodeData, decodeSeq,
} from './frame.js';
import { StreamEngine } from './stream-engine.js';

const LINGER_MS = 10000;
const TUNNEL_IDLE_MS = 60000;

const ERR_TO_CODE = { ECONNREFUSED: 5, ENETUNREACH: 3, EHOSTUNREACH: 4, ETIMEDOUT: 4, ENOTFOUND: 4, EAI_AGAIN: 4 };

function secretMatches(given, expected) {
  if (!expected) return true;
  const got = Buffer.from(String(given ?? ''), 'utf8');
  const want = Buffer.from(String(expected), 'utf8');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

// One client device = one tunnel = several subflows (one per physical link).
// Frames for a stream may arrive on any subflow; the StreamEngine reassembles
// them in order and forwards to the dialed target, and vice-versa.
class ServerTunnel {
  constructor(key, { dialFrom, log }) {
    this.key = key;
    this.dialFrom = dialFrom;
    this.log = log;
    this.subflows = new Set();
    this.streams = new Map(); // streamId -> { engine, target }
    this.lastSeen = Date.now();
  }

  addSubflow(socket) {
    const sf = { socket };
    this.subflows.add(sf);
    return sf;
  }

  removeSubflow(sf) {
    this.subflows.delete(sf);
    // A dropped subflow may have been mid-frame; surviving subflows carry the
    // retransmits, so just resend everything still in flight.
    for (const { engine } of this.streams.values()) engine.retransmitAll();
  }

  pickSubflow() {
    let best = null;
    let bestLen = Infinity;
    for (const sf of this.subflows) {
      if (sf.socket.writableLength < bestLen) {
        bestLen = sf.socket.writableLength;
        best = sf;
      }
    }
    return best;
  }

  send(frame) {
    const sf = this.pickSubflow();
    if (sf) sf.socket.write(frame);
  }

  onFrame(type, body) {
    this.lastSeen = Date.now();
    switch (type) {
      case T.PING:
        this.send(encodePong());
        break;
      case T.PONG:
        break;
      case T.OPEN:
        this.onOpen(decodeOpen(body));
        break;
      case T.DATA: {
        const { streamId, seq, payload } = decodeData(body);
        this.streams.get(streamId)?.engine.dataReceived(seq, payload);
        break;
      }
      case T.ACK: {
        const { streamId, seq } = decodeSeq(body);
        this.streams.get(streamId)?.engine.ackReceived(seq);
        break;
      }
      case T.FIN: {
        const { streamId, seq } = decodeSeq(body);
        this.streams.get(streamId)?.engine.finReceived(seq);
        break;
      }
      case T.RESET:
        this.streams.get(readStreamId(body))?.engine.reset(false);
        break;
      default:
        break;
    }
  }

  onOpen({ streamId, host, port }) {
    if (this.streams.has(streamId)) return;
    const target = net.connect({ host, port, noDelay: true, localAddress: this.dialFrom });
    const rec = { engine: null, target, opened: false };
    this.streams.set(streamId, rec);

    const engine = new StreamEngine(streamId, {
      send: (frame) => this.send(frame),
      onDeliver: (payload) => target.write(payload),
      onFinDelivered: () => target.end(),
      onReset: () => { target.destroy(); this.streams.delete(streamId); },
      onWindow: () => target.resume(),
    });
    rec.engine = engine;

    target.on('connect', () => {
      rec.opened = true;
      this.send(encodeOpenOk(streamId));
      target.on('data', (chunk) => {
        engine.write(chunk);
        if (!engine.canSend()) target.pause();
      });
    });
    target.on('drain', () => engine.resumeDelivery());
    target.on('end', () => engine.finish());
    target.on('error', (err) => {
      if (!rec.opened) this.send(encodeOpenErr(streamId, ERR_TO_CODE[err.code] ?? 1));
      else engine.reset();
      this.streams.delete(streamId);
    });
    target.on('close', () => {
      if (!engine.finSent) engine.finish();
    });
  }

  tick(now) {
    for (const [id, rec] of this.streams) {
      rec.engine.tick(now);
      if (rec.engine.isFinished()) {
        if (!rec.engine.doneAt) rec.engine.doneAt = now;
        else if (now - rec.engine.doneAt > LINGER_MS) {
          rec.engine.destroy();
          rec.target.destroy();
          this.streams.delete(id);
        }
      }
    }
  }

  destroyAll() {
    for (const rec of this.streams.values()) {
      rec.engine.destroy();
      rec.target.destroy();
    }
    this.streams.clear();
  }
}

export class TunnelServer {
  constructor({ secret = '', dialFrom = undefined, log }) {
    this.secret = secret;
    this.dialFrom = dialFrom;
    this.log = log;
    this.tunnels = new Map();
    this.timer = null;
    this.connections = 0;
  }

  listen(port, host, cb) {
    this.server = net.createServer((socket) => this.onConnection(socket));
    this.server.on('error', (err) => this.log.error(`server: ${err.message}`));
    this.server.listen(port, host, cb);
    this.timer = setInterval(() => this.tick(), 500);
    return this.server;
  }

  onConnection(socket) {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    this.connections += 1;
    const parser = new FrameParser();
    let tunnel = null;
    let sf = null;

    socket.on('data', (chunk) => {
      try {
        parser.push(chunk, (type, body) => {
          if (!tunnel) {
            if (type !== T.HELLO) throw new Error('expected HELLO');
            const { tunnelId, token } = decodeHello(body);
            if (!secretMatches(token, this.secret)) {
              this.log.warn('server: rejected subflow with bad secret');
              socket.destroy();
              return;
            }
            const key = tunnelId.toString('hex');
            tunnel = this.tunnels.get(key);
            if (!tunnel) {
              tunnel = new ServerTunnel(key, { dialFrom: this.dialFrom, log: this.log });
              this.tunnels.set(key, tunnel);
              this.log.info(`server: new tunnel ${key.slice(0, 8)} from ${socket.remoteAddress}`);
            }
            sf = tunnel.addSubflow(socket);
            socket.write(encodeHelloOk());
          } else {
            tunnel.onFrame(type, body);
          }
        });
      } catch (err) {
        this.log.debug(`server: dropping subflow: ${err.message}`);
        socket.destroy();
      }
    });

    socket.on('close', () => {
      this.connections -= 1;
      if (tunnel && sf) {
        tunnel.removeSubflow(sf);
        if (tunnel.subflows.size === 0) {
          tunnel.destroyAll();
          this.tunnels.delete(tunnel.key);
          this.log.info(`server: tunnel ${tunnel.key.slice(0, 8)} closed`);
        }
      }
    });
  }

  tick() {
    const now = Date.now();
    for (const [key, tunnel] of this.tunnels) {
      tunnel.tick(now);
      if (tunnel.subflows.size === 0 && now - tunnel.lastSeen > TUNNEL_IDLE_MS) {
        tunnel.destroyAll();
        this.tunnels.delete(key);
      }
    }
  }

  stats() {
    let streams = 0;
    for (const tunnel of this.tunnels.values()) streams += tunnel.streams.size;
    return { tunnels: this.tunnels.size, subflows: this.connections, streams };
  }
}
