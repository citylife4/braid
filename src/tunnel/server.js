import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  T, FrameParser, encodeHelloOk, encodeOpenOk, encodeOpenErr, encodePing, encodePong, encodeReset,
  readStreamId, decodeHello, decodeOpen, decodeData, decodeSeq,
} from './frame.js';
import { StreamEngine } from './stream-engine.js';

const LINGER_MS = 10000;
const TUNNEL_IDLE_MS = 60000;
const HELLO_TIMEOUT_MS = 10000; // drop connections that never authenticate
const PENDING_MAX = 4096; // parked control frames while no subflow is up
// The server pings each subflow itself: the measured round-trip feeds the
// downlink scheduler (most of a download's bytes flow server -> client), and
// a subflow that stops answering is recycled in seconds so its frames move
// to the surviving links quickly.
const PING_MS = 2000;
const DEAD_MS = 7000;
const DEFAULT_RTT = 50;

const ERR_TO_CODE = { ECONNREFUSED: 5, ENETUNREACH: 3, EHOSTUNREACH: 4, ETIMEDOUT: 4, ENOTFOUND: 4, EAI_AGAIN: 4 };

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
    this.pending = []; // control frames waiting for a subflow to return
    this.lastSeen = Date.now();
    this.nextSubflowId = 1;
  }

  addSubflow(socket) {
    const sf = { id: this.nextSubflowId++, socket, lastPong: Date.now(), lastPing: 0, pingSentAt: 0, srtt: null };
    this.subflows.add(sf);
    // Control frames (OPEN_OK, ACKs) parked while every subflow was gone.
    const queued = this.pending;
    this.pending = [];
    for (const frame of queued) this.send(frame);
    // Frames that had no subflow to ride (all links blipped at once) are
    // tagged via=null; dispatch them now instead of waiting out an RTO.
    for (const { engine } of this.streams.values()) engine.retransmitFor(null);
    return sf;
  }

  removeSubflow(sf) {
    this.subflows.delete(sf);
    // A dropped subflow may have been mid-frame; re-send exactly the frames
    // it was carrying over the surviving subflows.
    for (const { engine } of this.streams.values()) engine.retransmitFor(sf.id);
  }

  // Same scheduling as the client: least (queue × round-trip) wins, so a slow
  // or congested link stops attracting frames before it stalls the stream.
  pickSubflow(avoid = null) {
    let best = null;
    let bestScore = Infinity;
    let fallback = null;
    for (const sf of this.subflows) {
      if (sf.socket.destroyed) continue;
      const rtt = Math.max(sf.srtt ?? DEFAULT_RTT, 5);
      const score = (sf.socket.writableLength + 1) * rtt;
      if (sf.id === avoid) {
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

  send(frame, avoid = null) {
    const sf = this.pickSubflow(avoid);
    if (!sf) {
      // DATA/FIN sit in their engine's unacked list and are re-dispatched by
      // addSubflow; dropping a control frame (OPEN_OK, ACK) instead would
      // stall its stream until an RTO, so park those.
      const type = frame[4];
      if (type !== T.DATA && type !== T.FIN && this.pending.length < PENDING_MAX) {
        this.pending.push(frame);
      }
      return null;
    }
    sf.socket.write(frame);
    return sf.id;
  }

  onFrame(sf, type, body) {
    this.lastSeen = Date.now();
    switch (type) {
      case T.PING:
        // Reply on the subflow the ping arrived on — the client uses the pong
        // to judge that specific link's health and latency.
        sf.socket.write(encodePong());
        break;
      case T.PONG:
        sf.lastPong = Date.now();
        if (sf.pingSentAt) {
          const sample = sf.lastPong - sf.pingSentAt;
          sf.srtt = sf.srtt == null ? sample : Math.round(sf.srtt * 0.75 + sample * 0.25);
          sf.pingSentAt = 0;
        }
        break;
      case T.OPEN:
        this.onOpen(decodeOpen(body));
        break;
      case T.DATA: {
        const { streamId, seq, payload } = decodeData(body);
        const rec = this.streams.get(streamId);
        // DATA for an unknown stream = the client missed our teardown; answer
        // RESET (like a TCP RST) so it stops retransmitting into the void.
        if (rec) rec.engine.dataReceived(seq, payload);
        else this.send(encodeReset(streamId));
        break;
      }
      case T.ACK: {
        const { streamId, seq } = decodeSeq(body);
        this.streams.get(streamId)?.engine.ackReceived(seq);
        break;
      }
      case T.FIN: {
        const { streamId, seq } = decodeSeq(body);
        const rec = this.streams.get(streamId);
        if (rec) rec.engine.finReceived(seq);
        else this.send(encodeReset(streamId));
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
    let target;
    try {
      // net.connect throws synchronously on invalid input (port 0, bad host
      // string). That must fail this one stream, not the whole subflow.
      target = net.connect({ host, port, noDelay: true, localAddress: this.dialFrom });
    } catch {
      this.send(encodeOpenErr(streamId, 1));
      return;
    }
    const rec = { engine: null, target, opened: false };
    this.streams.set(streamId, rec);

    const engine = new StreamEngine(streamId, {
      send: (frame, avoid) => this.send(frame, avoid),
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
      engine.destroy(); // stop any pending ack timer for the dead stream
      this.streams.delete(streamId);
    });
    target.on('close', () => {
      if (!engine.finSent) engine.finish();
    });
  }

  tick(now) {
    for (const sf of [...this.subflows]) {
      if (now - sf.lastPong > DEAD_MS) {
        this.log.debug(`server: subflow ${sf.id} unresponsive — recycling`);
        sf.socket.destroy(); // the close handler retransmits its frames
        continue;
      }
      if (now - sf.lastPing >= PING_MS) {
        sf.lastPing = now;
        if (!sf.pingSentAt) sf.pingSentAt = now;
        sf.socket.write(encodePing());
      }
    }
    for (const [id, rec] of this.streams) {
      rec.engine.tick(now);
      if (rec.engine.closed || rec.engine.isFinished()) {
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

const tokenHash = (value) => createHash('sha256').update(String(value)).digest();

export class TunnelServer {
  constructor({ secret = '', dialFrom = undefined, log }) {
    this.secret = secret;
    // Compare fixed-length digests so the check leaks no timing information
    // about how much of the secret matched.
    this.secretHash = secret ? tokenHash(secret) : null;
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
    // A connection that never completes HELLO must not hold a socket open
    // forever (port scanners, misdirected clients).
    const helloTimer = setTimeout(() => {
      if (!tunnel) socket.destroy();
    }, HELLO_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      try {
        parser.push(chunk, (type, body) => {
          if (!tunnel) {
            if (type !== T.HELLO) throw new Error('expected HELLO');
            const { tunnelId, token } = decodeHello(body);
            if (this.secretHash && !timingSafeEqual(tokenHash(token), this.secretHash)) {
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
            tunnel.onFrame(sf, type, body);
          }
        });
      } catch (err) {
        this.log.debug(`server: dropping subflow: ${err.message}`);
        socket.destroy();
      }
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.connections -= 1;
      if (tunnel && sf) {
        tunnel.removeSubflow(sf);
        // A tunnel that just lost its last subflow is NOT torn down here: all
        // of a client's links can blip at once (USB adapter reset, laptop
        // resume). Streams stay parked so reconnecting subflows resume them;
        // tick() reaps the tunnel if the client stays away past the idle
        // window.
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
        this.log.info(`server: tunnel ${key.slice(0, 8)} closed (no subflows returned)`);
      }
    }
  }

  stats() {
    let streams = 0;
    for (const tunnel of this.tunnels.values()) streams += tunnel.streams.size;
    return { tunnels: this.tunnels.size, subflows: this.connections, streams };
  }
}
