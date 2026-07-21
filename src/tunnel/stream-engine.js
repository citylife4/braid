import { CHUNK, encodeData, encodeAck, encodeFin, encodeReset } from './frame.js';

// Per-stream reliability + reordering, one instance per direction-pair.
//
// The tunnel sprays a stream's DATA frames across multiple TCP subflows, so
// they arrive out of order and a dying subflow can drop whatever it was
// carrying. This engine rebuilds a clean, ordered byte stream on top of that:
//
//   send side  - number every frame, keep unacked frames and remember which
//                subflow carried them. When a subflow dies, only ITS frames
//                are retransmitted (on the survivors); when a cumulative ACK
//                stalls, the oldest in-flight frames are re-sent in a bounded
//                batch, preferring a different subflow than last time. A
//                bounded send window gives end-to-end flow control.
//   recv side  - reorder by sequence, drop duplicates, deliver contiguously,
//                and pause delivery (stop ACKing) when the sink is slow.
//
// FIN occupies its own sequence number, so end-of-stream is delivered exactly
// once, in order, and is retransmitted reliably like any other frame.
export const SEND_WINDOW = 4 * 1024 * 1024;
const ACK_DELAY_MS = 4;
const RTO_MIN = 500;
const RTO_MAX = 4000;
// Cap how much a stalled stream re-sends per RTO. Re-sending the oldest frames
// first unblocks the receiver's head-of-line without duplicating a whole
// window's worth of data the way a blanket retransmit would.
const RETRANSMIT_BATCH = 64; // frames (~1 MB at 16 KB CHUNK)

const FIN_MARK = Symbol('fin');

export class StreamEngine {
  constructor(streamId, { send, onDeliver, onFinDelivered, onReset, onWindow }) {
    this.id = streamId;
    this.send = send; // (frame, avoidVia) => viaId | null — hands a frame to the tunnel scheduler
    this.onDeliver = onDeliver; // (payload) => boolean  — false means "sink is full, pause"
    this.onFinDelivered = onFinDelivered;
    this.onReset = onReset;
    this.onWindow = onWindow; // () => void  — send window has room again

    // send side
    this.seqNext = 0;
    this.unacked = new Map(); // seq -> { frame, len, via, sentAt }
    this.unackedBytes = 0;
    this.finSent = false;
    this.rto = RTO_MIN;
    this.lastProgress = Date.now();

    // recv side
    this.rcvNext = 0;
    this.reorder = new Map(); // seq -> payload | FIN_MARK
    this.paused = false;
    this.finDelivered = false;
    this.ackTimer = null;

    this.closed = false;
    this.doneAt = 0;
  }

  canSend() {
    return this.unackedBytes < SEND_WINDOW;
  }

  // Hand a frame to the scheduler, remembering which subflow took it so a
  // dying subflow can retransmit exactly its own frames.
  dispatch(entry, avoid = null) {
    entry.via = this.send(entry.frame, avoid) ?? null;
    entry.sentAt = Date.now();
  }

  // App/target -> wire. Splits into CHUNK-sized DATA frames.
  write(chunk) {
    let off = 0;
    do {
      const slice = chunk.subarray(off, off + CHUNK);
      off += slice.length || 1;
      const seq = this.seqNext++;
      const entry = { frame: encodeData(this.id, seq, slice), len: slice.length, via: null, sentAt: 0 };
      this.unacked.set(seq, entry);
      this.unackedBytes += slice.length;
      this.dispatch(entry);
    } while (off < chunk.length);
  }

  finish() {
    if (this.finSent) return;
    this.finSent = true;
    const seq = this.seqNext++;
    const entry = { frame: encodeFin(this.id, seq), len: 0, via: null, sentAt: 0 };
    this.unacked.set(seq, entry);
    this.dispatch(entry);
  }

  // Cumulative ACK: peer has contiguously received everything below nextSeq.
  ackReceived(nextSeq) {
    const wasFull = !this.canSend();
    let advanced = false;
    for (const [seq, entry] of this.unacked) {
      if (seq >= nextSeq) continue;
      this.unacked.delete(seq);
      this.unackedBytes -= entry.len;
      advanced = true;
    }
    if (advanced) {
      this.lastProgress = Date.now();
      this.rto = RTO_MIN;
      if (wasFull && this.canSend()) this.onWindow?.();
    }
  }

  dataReceived(seq, payload) {
    if (seq >= this.rcvNext && !this.reorder.has(seq)) {
      this.reorder.set(seq, payload);
      this.flush();
    }
    this.scheduleAck();
  }

  finReceived(seq) {
    if (seq >= this.rcvNext && !this.reorder.has(seq)) {
      this.reorder.set(seq, FIN_MARK);
      this.flush();
    }
    this.scheduleAck();
  }

  flush() {
    while (!this.paused && this.reorder.has(this.rcvNext)) {
      const value = this.reorder.get(this.rcvNext);
      this.reorder.delete(this.rcvNext);
      this.rcvNext += 1;
      if (value === FIN_MARK) {
        if (!this.finDelivered) {
          this.finDelivered = true;
          this.onFinDelivered?.();
        }
      } else if (this.onDeliver(value) === false) {
        this.paused = true;
      }
    }
  }

  // Sink drained (app reader ready / target socket drained): resume delivery.
  resumeDelivery() {
    if (!this.paused) return;
    this.paused = false;
    this.flush();
  }

  scheduleAck() {
    if (this.ackTimer || this.closed) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (!this.closed) this.send(encodeAck(this.id, this.rcvNext));
    }, ACK_DELAY_MS);
  }

  // A subflow died: re-send exactly the frames it was carrying, preferring a
  // surviving subflow. Frames on healthy subflows stay where they are.
  retransmitFor(viaId) {
    let moved = 0;
    for (const entry of this.unacked.values()) {
      if (entry.via !== viaId) continue;
      this.dispatch(entry, viaId);
      moved += 1;
    }
    if (moved) this.lastProgress = Date.now();
    return moved;
  }

  // Periodic tick from the tunnel. When the cumulative ACK stalls, re-send
  // the oldest still-unacked frames (a bounded batch, oldest first — the
  // receiver's head-of-line), each preferably on a different subflow than
  // the one that stalled.
  tick(now) {
    if (!this.unacked.size || now - this.lastProgress <= this.rto) return;
    let sent = 0;
    for (const entry of this.unacked.values()) {
      if (now - entry.sentAt <= this.rto) continue;
      this.dispatch(entry, entry.via);
      sent += 1;
      if (sent >= RETRANSMIT_BATCH) break;
    }
    if (sent) {
      this.lastProgress = now;
      this.rto = Math.min(RTO_MAX, this.rto * 2);
    }
  }

  isFinished() {
    return this.finDelivered && this.finSent && this.unacked.size === 0;
  }

  reset(local = true) {
    if (this.closed) return;
    if (local) this.send(encodeReset(this.id));
    this.destroy();
    this.onReset?.();
  }

  destroy() {
    this.closed = true;
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.unacked.clear();
    this.reorder.clear();
  }
}
