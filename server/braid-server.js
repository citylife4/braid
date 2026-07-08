#!/usr/bin/env node
// braid-server — the reassembly point that makes single-stream bonding real.
//
// Runs on a VPS with a public IP. braid clients open one member connection per
// physical link to this server; application streams are multiplexed across all
// of a session's members and reassembled here in byte order, then forwarded to
// the real destination. Return traffic is split back across the members.
//
// Zero dependencies. Start it with a shared key that matches the client's:
//   node braid-server.js --key <secret> [--port 7900] [--host 0.0.0.0]
import net from 'node:net';
import crypto from 'node:crypto';
import process from 'node:process';
import {
  T, VERSION, CLOSE_RST,
  encodeFrame, jsonFrame, createFrameParser,
  decodeData, decodeAck, decodeClose,
} from '../src/bond/protocol.js';
import { Channel } from '../src/bond/channel.js';

const args = parseArgs(process.argv);
if (!args.key) {
  console.error('braid-server: --key <secret> is required (must match the client).');
  process.exit(1);
}
const KEY = Buffer.from(args.key);
const DIAL_TIMEOUT = 10000;
const SESSION_GRACE = 30000; // keep a memberless session alive this long for reconnect

const sessions = new Map(); // sessionId -> Session
const log = (...a) => console.log(new Date().toISOString(), ...a);

function keyOk(given) {
  const g = Buffer.from(String(given ?? ''));
  return g.length === KEY.length && crypto.timingSafeEqual(g, KEY);
}

class Session {
  constructor(id) {
    this.id = id;
    this.members = new Map(); // memberId -> { socket, weight, current }
    this.streams = new Map(); // streamId -> { channel, dest }
    this.graceTimer = null;
  }

  addMember(id, socket, weight) {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.members.set(id, { socket, weight: weight > 0 ? weight : 1, current: 0 });
    for (const { channel } of this.streams.values()) channel.flush();
  }

  removeMember(id) {
    this.members.delete(id);
    for (const { channel } of this.streams.values()) channel.onMemberDown(id);
    if (this.members.size === 0) {
      this.graceTimer = setTimeout(() => this.destroy('no members'), SESSION_GRACE);
    }
  }

  // Smooth weighted round-robin across live members; returns the member id used.
  schedule(frame) {
    let total = 0;
    let best = null;
    let bestId = null;
    for (const [id, m] of this.members) {
      m.current += m.weight;
      total += m.weight;
      if (!best || m.current > best.current) { best = m; bestId = id; }
    }
    if (!best) return null;
    best.current -= total;
    best.socket.write(frame);
    return bestId;
  }

  openStream(streamId, host, port, replyMember) {
    if (this.streams.has(streamId)) return;
    const dest = net.connect({ host, port, noDelay: true });
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      dest.destroy();
      replyMember.write(jsonFrame(T.OPEN_OK, { stream: streamId, ok: false, code: 'ETIMEDOUT' }));
    }, DIAL_TIMEOUT);

    dest.once('connect', () => {
      if (settled) { dest.destroy(); return; }
      clearTimeout(timer);
      settled = true;
      const channel = new Channel(streamId, {
        schedule: (frame) => this.schedule(frame),
        deliver: (buf) => dest.write(buf),
      });
      this.streams.set(streamId, { channel, dest });

      dest.on('data', (chunk) => { if (!channel.write(chunk)) dest.pause(); });
      channel.on('drain', () => dest.resume());
      dest.on('end', () => channel.end());
      channel.on('remote-end', () => dest.end());
      channel.on('remote-reset', () => dest.destroy());
      dest.on('error', () => {});
      dest.on('close', () => this.closeStream(streamId, false));

      replyMember.write(jsonFrame(T.OPEN_OK, { stream: streamId, ok: true }));
    });
    dest.once('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      replyMember.write(jsonFrame(T.OPEN_OK, { stream: streamId, ok: false, code: err.code || 'EFAIL' }));
    });
  }

  closeStream(streamId, alreadyReset) {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    if (!alreadyReset && !s.channel.finSent) s.channel.reset();
    s.dest.destroy();
  }

  destroy(reason) {
    clearTimeout(this.graceTimer);
    for (const s of this.streams.values()) s.dest.destroy();
    for (const m of this.members.values()) m.socket.destroy();
    sessions.delete(this.id);
    log(`session ${this.id.slice(0, 8)} destroyed (${reason})`);
  }
}

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let session = null;
  let memberId = null;

  const parse = createFrameParser(onFrame, () => socket.destroy());
  socket.on('data', parse);
  socket.on('error', () => {});
  socket.on('close', () => {
    if (session && memberId != null) session.removeMember(memberId);
  });

  function onFrame(type, body) {
    if (!session) {
      if (type !== T.HELLO) { socket.destroy(); return; }
      let hello;
      try { hello = JSON.parse(body.toString('utf8')); } catch { socket.destroy(); return; }
      if (hello.v !== VERSION || !keyOk(hello.key) || !hello.session) {
        socket.write(jsonFrame(T.HELLO_OK, { ok: false, error: 'rejected' }));
        socket.destroy();
        return;
      }
      session = sessions.get(hello.session);
      if (!session) { session = new Session(hello.session); sessions.set(hello.session, session); }
      memberId = hello.link || `m${session.members.size}`;
      session.addMember(memberId, socket, Number(hello.weight) || 1);
      socket.write(jsonFrame(T.HELLO_OK, { ok: true }));
      log(`session ${hello.session.slice(0, 8)} + member ${memberId} (${session.members.size} total)`);
      return;
    }

    switch (type) {
      case T.OPEN: {
        let o;
        try { o = JSON.parse(body.toString('utf8')); } catch { return; }
        session.openStream(o.stream >>> 0, o.host, o.port, socket);
        break;
      }
      case T.DATA: {
        const { stream, offset, payload } = decodeData(body);
        session.streams.get(stream)?.channel.onData(offset, payload);
        break;
      }
      case T.ACK: {
        const { stream, ackOffset } = decodeAck(body);
        session.streams.get(stream)?.channel.onAck(ackOffset);
        break;
      }
      case T.CLOSE: {
        const { stream, flag, finalOffset } = decodeClose(body);
        const s = session.streams.get(stream);
        if (s) {
          s.channel.onClose(flag, finalOffset);
          if (flag === CLOSE_RST) session.closeStream(stream, true);
        }
        break;
      }
      case T.PING:
        socket.write(encodeFrame(T.PONG, body));
        break;
      default:
        break;
    }
  }
});

server.on('error', (err) => {
  console.error(`braid-server: ${err.code === 'EADDRINUSE' ? `port ${args.port} in use` : err.message}`);
  process.exit(1);
});
server.listen(args.port, args.host, () => {
  log(`braid-server v${VERSION} listening on ${args.host}:${args.port}`);
});

setInterval(() => {
  let members = 0, streams = 0;
  for (const s of sessions.values()) { members += s.members.size; streams += s.streams.size; }
  if (sessions.size) log(`status: ${sessions.size} session(s), ${members} member(s), ${streams} stream(s)`);
}, 60000).unref();

function parseArgs(argv) {
  const args = { port: 7900, host: '0.0.0.0', key: process.env.BRAID_KEY || null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--key') args.key = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node braid-server.js --key <secret> [--port 7900] [--host 0.0.0.0]');
      process.exit(0);
    }
  }
  return args;
}
