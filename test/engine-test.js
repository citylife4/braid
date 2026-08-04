import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamEngine } from '../src/tunnel/stream-engine.js';
import { T } from '../src/tunnel/frame.js';

function makeEngine({ deliver = () => true } = {}) {
  const sent = [];
  const events = { reset: 0, fin: 0 };
  const engine = new StreamEngine(7, {
    send: (frame) => { sent.push(frame); return 'link0'; },
    onDeliver: deliver,
    onFinDelivered: () => { events.fin += 1; },
    onReset: () => { events.reset += 1; },
    onWindow: () => {},
  });
  return { engine, sent, events };
}

const sentTypes = (sent) => sent.map((frame) => frame[4]);

test('a closed engine ignores writes, fins and inbound frames', () => {
  const { engine, sent } = makeEngine();
  engine.destroy();
  engine.write(Buffer.from('data'));
  engine.finish();
  engine.dataReceived(0, Buffer.from('x'));
  engine.finReceived(1);
  engine.ackReceived(5);
  assert.equal(sent.length, 0, 'closed engine must not emit frames');
  assert.equal(engine.unacked.size, 0);
  assert.equal(engine.reorder.size, 0);
});

test('an orphaned engine resets once arriving data cannot be delivered', () => {
  // Deliver fails (the app socket is destroyed), as push() does on a dead stream.
  const { engine, sent, events } = makeEngine({ deliver: () => false });
  engine.orphan();
  assert.equal(engine.closed, false, 'orphaning alone must not reset (tail flush)');

  engine.dataReceived(0, Buffer.from('undeliverable'));
  engine.tick(Date.now());
  assert.equal(engine.closed, true, 'undeliverable data must reset the orphan');
  assert.equal(events.reset, 1);
  assert.ok(sentTypes(sent).includes(T.RESET), 'the peer must be told via RESET');
});

test('an orphaned engine may flush its tail, then resets when the grace expires', () => {
  const { engine, sent } = makeEngine();
  const now = Date.now();
  engine.write(Buffer.from('tail'));
  engine.finish();
  engine.orphan();

  engine.tick(now + 1000);
  assert.equal(engine.closed, false, 'within the grace period the tail may still flush');

  // The peer acks everything and fins: the orphan finishes cleanly, no reset.
  engine.ackReceived(engine.seqNext);
  engine.finReceived(0);
  assert.equal(engine.isFinished(), true);
  engine.tick(now + 2000);
  assert.equal(engine.closed, false, 'a finished orphan must not reset');
  assert.ok(!sentTypes(sent).includes(T.RESET));
});

test('an orphaned engine that never finishes resets after the grace period', () => {
  const { engine, sent } = makeEngine();
  engine.write(Buffer.from('tail'));
  engine.orphan();
  engine.tick(Date.now() + 31000);
  assert.equal(engine.closed, true);
  assert.ok(sentTypes(sent).includes(T.RESET));
});
