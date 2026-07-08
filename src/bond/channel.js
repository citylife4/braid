import { EventEmitter } from 'node:events';
import {
  Reassembler, encodeData, encodeAck, encodeClose,
  CHUNK, HIGH_WATER, LOW_WATER, CLOSE_FIN, CLOSE_RST,
} from './protocol.js';

// One multiplexed stream, from either end's point of view. Identical logic on
// client and server — only what sits at each edge differs (an app socket vs a
// destination socket), which the owner wires via callbacks.
//
// Owner provides:
//   schedule(frameBuffer, streamId) -> memberId | null   (put bytes on a link)
//   deliver(buffer)                                       (hand received bytes to the edge socket)
// Owner drives it with onData / onAck / onClose / onMemberDown / flush, and
// listens for:
//   'drain'  -> inflight fell below LOW_WATER, safe to resume the source
//   'remote-end'   (finalOffset reached: peer half-closed gracefully)
//   'remote-reset' (peer aborted)
export class Channel extends EventEmitter {
  constructor(id, { schedule, deliver }) {
    super();
    this.id = id;
    this.schedule = schedule;
    this.reasm = new Reassembler((buf) => deliver(buf));

    this.sendOffset = 0;         // next byte offset to assign when sending
    this.ackedOffset = 0;        // peer has this many contiguous bytes
    this.inflight = [];          // [{offset, buf, member}] not yet fully acked, in offset order
    this.inflightBytes = 0;
    this.paused = false;

    this.finSent = false;
    this.finalRecvOffset = null; // set when a FIN arrives; end delivered once reassembly reaches it
    this.closed = false;

    this._ackScheduled = false;
  }

  // --- sending local data out across the links ---
  write(buf) {
    if (this.finSent || this.closed) return true;
    let at = 0;
    while (at < buf.length) {
      const slice = buf.subarray(at, at + CHUNK);
      at += slice.length;
      const seg = { offset: this.sendOffset, buf: slice, member: null };
      this.sendOffset += slice.length;
      this.inflight.push(seg);
      this.inflightBytes += slice.length;
      seg.member = this.schedule(encodeData(this.id, seg.offset, seg.buf), this.id);
    }
    if (this.inflightBytes >= HIGH_WATER) this.paused = true;
    return !this.paused;
  }

  end() {
    if (this.finSent || this.closed) return;
    this.finSent = true;
    this.schedule(encodeClose(this.id, CLOSE_FIN, this.sendOffset), this.id);
    this._maybeDone();
  }

  reset() {
    if (this.closed) return;
    this.schedule(encodeClose(this.id, CLOSE_RST, this.sendOffset), this.id);
    this.closed = true;
  }

  // --- receiving frames from the peer ---
  onData(offset, payload) {
    if (this.closed) return;
    const expected = this.reasm.push(offset, payload);
    this._scheduleAck(expected);
    if (this.finalRecvOffset !== null && this.reasm.expected >= this.finalRecvOffset) {
      this.emit('remote-end');
    }
  }

  onAck(ackOffset) {
    if (ackOffset > this.ackedOffset) this.ackedOffset = ackOffset;
    while (this.inflight.length) {
      const seg = this.inflight[0];
      if (seg.offset + seg.buf.length > this.ackedOffset) break;
      this.inflight.shift();
      this.inflightBytes -= seg.buf.length;
    }
    if (this.paused && this.inflightBytes <= LOW_WATER) {
      this.paused = false;
      this.emit('drain');
    }
    this._maybeDone();
  }

  onClose(flag, finalOffset) {
    if (flag === CLOSE_RST) {
      this.closed = true;
      this.emit('remote-reset');
      return;
    }
    this.finalRecvOffset = finalOffset;
    if (this.reasm.expected >= finalOffset) this.emit('remote-end');
  }

  // A member (link) died: re-send every still-inflight segment it was carrying
  // over a surviving member. Retransmits reuse the exact offset+length, so the
  // peer's reassembler dedups them harmlessly.
  onMemberDown(memberId) {
    for (const seg of this.inflight) {
      if (seg.member === memberId) {
        seg.member = this.schedule(encodeData(this.id, seg.offset, seg.buf), this.id);
      }
    }
  }

  // A member came up (or we had none before): push out anything unscheduled.
  flush() {
    for (const seg of this.inflight) {
      if (seg.member === null) {
        seg.member = this.schedule(encodeData(this.id, seg.offset, seg.buf), this.id);
      }
    }
  }

  _maybeDone() {
    if (this.finSent && this.inflight.length === 0 && !this.closed) {
      this.emit('sent-all');
    }
  }

  // Coalesce ACKs to at most one per event-loop turn to avoid ACK storms.
  _scheduleAck(expected) {
    this._pendingAck = expected;
    if (this._ackScheduled) return;
    this._ackScheduled = true;
    setImmediate(() => {
      this._ackScheduled = false;
      if (!this.closed) this.schedule(encodeAck(this.id, this._pendingAck), this.id);
    });
  }
}
