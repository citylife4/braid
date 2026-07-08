// Wire framing for the braid bonding tunnel.
//
// Every frame is length-prefixed: [uint32 len][uint8 type][body(len-1)].
// One logical app connection ("stream") is split into DATA frames that are
// sprayed across all subflows (one TCP connection per physical link) and
// reassembled in order at the far end using per-stream sequence numbers.
export const CHUNK = 16384; // max DATA payload; keeps frames small enough to spread
export const MAX_FRAME = CHUNK + 256;

export const T = {
  HELLO: 1,     // subflow -> server: join a tunnel   [16 tunnelId][1 tokenLen][token]
  HELLO_OK: 2,  // server -> subflow: accepted
  OPEN: 3,      // client -> server: open stream       [4 streamId][2 port][1 hostLen][host]
  OPEN_OK: 4,   // server -> client: target dialed     [4 streamId]
  OPEN_ERR: 5,  // server -> client: dial failed        [4 streamId][1 code]
  DATA: 6,      // either way: ordered payload          [4 streamId][4 seq][payload]
  ACK: 7,       // either way: cumulative ack           [4 streamId][4 nextExpectedSeq]
  FIN: 8,       // either way: end of stream at seq     [4 streamId][4 seq]
  RESET: 9,     // either way: abort stream             [4 streamId]
  PING: 10,     // subflow keepalive
  PONG: 11,
};

function frame(type, body = Buffer.alloc(0)) {
  const out = Buffer.allocUnsafe(5 + body.length);
  out.writeUInt32BE(1 + body.length, 0);
  out.writeUInt8(type, 4);
  if (body.length) body.copy(out, 5);
  return out;
}

export function encodeHello(tunnelId, token = '') {
  const t = Buffer.from(token, 'utf8');
  const body = Buffer.allocUnsafe(17 + t.length);
  tunnelId.copy(body, 0);
  body.writeUInt8(t.length, 16);
  t.copy(body, 17);
  return frame(T.HELLO, body);
}
export const encodeHelloOk = () => frame(T.HELLO_OK);

export function encodeOpen(streamId, host, port) {
  const h = Buffer.from(host, 'utf8');
  const body = Buffer.allocUnsafe(7 + h.length);
  body.writeUInt32BE(streamId, 0);
  body.writeUInt16BE(port, 4);
  body.writeUInt8(h.length, 6);
  h.copy(body, 7);
  return frame(T.OPEN, body);
}
export function encodeOpenOk(streamId) {
  const body = Buffer.allocUnsafe(4);
  body.writeUInt32BE(streamId, 0);
  return frame(T.OPEN_OK, body);
}
export function encodeOpenErr(streamId, code) {
  const body = Buffer.allocUnsafe(5);
  body.writeUInt32BE(streamId, 0);
  body.writeUInt8(code, 4);
  return frame(T.OPEN_ERR, body);
}
export function encodeData(streamId, seq, payload) {
  const body = Buffer.allocUnsafe(8 + payload.length);
  body.writeUInt32BE(streamId, 0);
  body.writeUInt32BE(seq, 4);
  payload.copy(body, 8);
  return frame(T.DATA, body);
}
export function encodeAck(streamId, nextSeq) {
  const body = Buffer.allocUnsafe(8);
  body.writeUInt32BE(streamId, 0);
  body.writeUInt32BE(nextSeq, 4);
  return frame(T.ACK, body);
}
export function encodeFin(streamId, seq) {
  const body = Buffer.allocUnsafe(8);
  body.writeUInt32BE(streamId, 0);
  body.writeUInt32BE(seq, 4);
  return frame(T.FIN, body);
}
export function encodeReset(streamId) {
  const body = Buffer.allocUnsafe(4);
  body.writeUInt32BE(streamId, 0);
  return frame(T.RESET, body);
}
export const encodePing = () => frame(T.PING);
export const encodePong = () => frame(T.PONG);

// Incremental frame reader. Feed it socket chunks; it invokes onFrame for
// each complete frame and keeps the remainder buffered.
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk, onFrame) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME) throw new Error(`bad frame length ${len}`);
      if (this.buf.length < 4 + len) return;
      const type = this.buf.readUInt8(4);
      const body = this.buf.subarray(5, 4 + len);
      onFrame(type, body);
      this.buf = this.buf.subarray(4 + len);
    }
  }
}

// Body decoders (return plain objects).
export const readStreamId = (body) => body.readUInt32BE(0);
export const decodeOpen = (body) => ({
  streamId: body.readUInt32BE(0),
  port: body.readUInt16BE(4),
  host: body.subarray(7, 7 + body.readUInt8(6)).toString('utf8'),
});
export const decodeOpenErr = (body) => ({ streamId: body.readUInt32BE(0), code: body.readUInt8(4) });
export const decodeData = (body) => ({
  streamId: body.readUInt32BE(0),
  seq: body.readUInt32BE(4),
  payload: body.subarray(8),
});
export const decodeSeq = (body) => ({ streamId: body.readUInt32BE(0), seq: body.readUInt32BE(4) });
export const decodeHello = (body) => ({
  tunnelId: body.subarray(0, 16),
  token: body.subarray(17, 17 + body.readUInt8(16)).toString('utf8'),
});
