import { CHUNK, encodeData, encodeAck, encodeFin, encodeReset } from './frame.js';

// Per-stream reliability + reordering, one instance per direction-pair.
//
// The tunnel sprays a stream's DATA frames across multiple TCP subflows, so
// they arrive out of order and a dying subflow can drop whatever it was
// carrying. This engine rebuilds a clean, ordered byte stream on top of that:
//
//   send side  - number every frame, keep unacked frames, retransmit on any
//                surviving subflow when a cumulative ACK stalls or a subflow
//                dies. A bounded send window gives end-to-end flow control.
//   recv side  - reorder by sequence, drop duplicates, deliver contiguously,
//                and pause delivery (stop ACKing) when the sink is slow.
//
// FIN occupies its own sequence number, so end-of-stream is delivered exactly
// once, in order, and is retransmitted reliably like any other frame.
export const SEND_WINDOW = 4 * 1024 * 1024;
const ACK_DELAY_MS = 4;
const RTO_MIN = 500;
const RTO_MAX = 4000;

const FIN_MARK = Symbol('fin');

export class StreamEngine {
  constructor(streamId, { send, onDeliver, onFinDelivered, onReset, onWindow }) {
    this.id = streamId;
    this.send = send; // (framedBuffer) => void  — hands a frame to the tunnel scheduler
    this.onDeliver = onDeliver; // (payload) => boolean  — false means "sink is full, pause"
    this.onFinDelivered = onFinDelivered;
    this.onReset = onReset;
    this.onWindow = onWindow; // () => void  — send window has room again

    // send side
    this.seqNext = 0;
    this.unacked = new Map(); // seq -> { frame, len }
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

  // App/target -> wire. Splits into CHUNK-sized DATA frames.
  write(chunk) {
    let off = 0;
    do {
      const slice = chunk.subarray(off, off + CHUNK);
      off += slice.length || 1;
      const seq = this.seqNext++;
      const frame = encodeData(this.id, seq, slice);
      this.unacked.set(seq, { frame, len: slice.length });
      this.unackedBytes += slice.length;
      this.send(frame);
    } while (off < chunk.length);
  }

  finish() {
    if (this.finSent) return;
    this.finSent = true;
    const seq = this.seqNext++;
    const frame = encodeFin(this.id, seq);
    this.unacked.set(seq, { frame, len: 0 });
    this.send(frame);
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

  // Called when a subflow dies: resend everything still in flight at once.
  retransmitAll() {
    for (const { frame } of this.unacked.values()) this.send(frame);
    this.lastProgress = Date.now();
  }

  // Periodic tick from the tunnel. Retransmits on RTO, reports when the
  // stream is fully finished (both directions) after a short linger.
  tick(now) {
    if (this.unacked.size && now - this.lastProgress > this.rto) {
      this.retransmitAll();
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
