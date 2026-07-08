// braid bonding protocol — shared by the client (local) and the server (VPS).
//
// A "session" is a set of member TCP connections, one per physical link, all
// pointing at the same braid-server. Application connections become "streams"
// multiplexed across every member: a single stream's bytes are chunked into
// DATA frames and sprayed over all links, then reassembled in order at the far
// end by byte offset (like TCP, but across multiple paths). That reassembly
// point on the far end is what lets one download's speed add up across links.
//
// Wire format, per member connection (little-endian):
//   type:u8 | len:u32 | body[len]
//
// DATA/ACK/CLOSE bodies use a 6-byte (u48) byte offset so a single stream can
// carry up to 256 TB before wrapping — effectively never for a proxy.

export const VERSION = 3;

export const T = {
  HELLO: 1,     // client->server: {v, session, link, key}
  HELLO_OK: 2,  // server->client: {ok, error?}
  OPEN: 3,      // client->server: {stream, host, port}
  OPEN_OK: 4,   // server->client: {stream, ok, error?, code?}
  DATA: 5,      // either way: stream:u32 | offset:u48 | payload
  ACK: 6,       // either way: stream:u32 | ackOffset:u48   (highest contiguous byte delivered)
  CLOSE: 7,     // either way: stream:u32 | flag:u8 | finalOffset:u48   (flag 0=FIN, 1=RST)
  PING: 8,      // keepalive: u48 timestamp
  PONG: 9,      // echo of PING timestamp
};

export const CLOSE_FIN = 0;
export const CLOSE_RST = 1;

export const MAX_FRAME = 16 * 1024 * 1024; // reject anything larger (anti-DoS)
export const CHUNK = 32 * 1024;            // payload bytes per DATA frame
export const HIGH_WATER = 2 * 1024 * 1024; // per-stream inflight cap -> pause source
export const LOW_WATER = 512 * 1024;       // resume source below this

const U48_MAX = 0xffffffffffff;

export function encodeFrame(type, body) {
  const len = body ? body.length : 0;
  const head = Buffer.allocUnsafe(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(len, 1);
  return len ? Buffer.concat([head, body]) : head;
}

export const jsonFrame = (type, obj) => encodeFrame(type, Buffer.from(JSON.stringify(obj), 'utf8'));

export function encodeData(stream, offset, payload) {
  const b = Buffer.allocUnsafe(10 + payload.length);
  b.writeUInt32LE(stream, 0);
  b.writeUIntLE(offset % (U48_MAX + 1), 4, 6);
  payload.copy(b, 10);
  return encodeFrame(T.DATA, b);
}
export function decodeData(body) {
  return { stream: body.readUInt32LE(0), offset: body.readUIntLE(4, 6), payload: body.subarray(10) };
}

export function encodeAck(stream, ackOffset) {
  const b = Buffer.allocUnsafe(10);
  b.writeUInt32LE(stream, 0);
  b.writeUIntLE(ackOffset, 4, 6);
  return encodeFrame(T.ACK, b);
}
export const decodeAck = (body) => ({ stream: body.readUInt32LE(0), ackOffset: body.readUIntLE(4, 6) });

export function encodeClose(stream, flag, finalOffset) {
  const b = Buffer.allocUnsafe(11);
  b.writeUInt32LE(stream, 0);
  b.writeUInt8(flag, 4);
  b.writeUIntLE(finalOffset, 5, 6);
  return encodeFrame(T.CLOSE, b);
}
export const decodeClose = (body) => ({
  stream: body.readUInt32LE(0),
  flag: body.readUInt8(4),
  finalOffset: body.readUIntLE(5, 6),
});

// Streaming frame parser. Feed it chunks; it calls onFrame(type, body) for each
// complete frame. Calls onError and stops on an oversized length.
export function createFrameParser(onFrame, onError) {
  let buf = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 5) return;
      const len = buf.readUInt32LE(1);
      if (len > MAX_FRAME) {
        broken = true;
        onError?.(new Error(`frame too large (${len})`));
        return;
      }
      if (buf.length < 5 + len) return;
      const type = buf.readUInt8(0);
      const body = buf.subarray(5, 5 + len);
      buf = buf.subarray(5 + len);
      onFrame(type, body);
    }
  };
}

// Reassembles a byte stream from segments that may arrive out of order and may
// be retransmitted (duplicates / partial overlaps). Delivers only new, in-order
// bytes via onData. Because every byte is sent exactly once per its offset and
// retransmits reuse the identical offset+length, dedup by left edge is enough.
export class Reassembler {
  constructor(onData) {
    this.expected = 0;
    this.pending = new Map(); // offset -> Buffer (strictly future segments)
    this.buffered = 0;
    this.onData = onData;
  }

  push(offset, buf) {
    if (offset > this.expected) {
      if (!this.pending.has(offset)) {
        this.pending.set(offset, buf);
        this.buffered += buf.length;
      }
      return this.expected;
    }
    // offset <= expected: trim bytes we've already delivered
    if (offset < this.expected) {
      const skip = this.expected - offset;
      if (skip >= buf.length) return this.expected; // wholly old
      buf = buf.subarray(skip);
    }
    this.onData(buf);
    this.expected += buf.length;
    // drain any now-contiguous pending segments
    for (;;) {
      const next = this.pending.get(this.expected);
      if (!next) break;
      this.pending.delete(this.expected);
      this.buffered -= next.length;
      this.onData(next);
      this.expected += next.length;
    }
    return this.expected;
  }
}
