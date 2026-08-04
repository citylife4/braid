import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startUdpAssociation } from '../src/udp.js';

const silent = { debug() {} };

function makeControl() {
  const control = new EventEmitter();
  control.destroy = () => control.emit('close');
  return control;
}

test('a failed relay setup rejects and leaves the udp flow counter at zero', async () => {
  let flows = 0;
  const manager = {
    trackUdp: () => { flows += 1; },
    untrackUdp: () => { flows -= 1; },
    resolveHost: async () => '127.0.0.1',
  };
  const link = { name: 'test', address: '203.0.113.9', bytesIn: 0, bytesOut: 0 };
  await assert.rejects(startUdpAssociation({
    control: makeControl(),
    clientIp: '127.0.0.1',
    bindAddress: '203.0.113.9', // not a local address: bind must fail
    link,
    manager,
    log: silent,
  }));
  assert.equal(flows, 0, 'a setup failure must not drive udpFlows negative');
});

test('a successful association tracks and untracks exactly once', async () => {
  let flows = 0;
  const manager = {
    trackUdp: () => { flows += 1; },
    untrackUdp: () => { flows -= 1; },
    resolveHost: async () => '127.0.0.1',
  };
  const link = { name: 'test', address: '127.0.0.1', bytesIn: 0, bytesOut: 0 };
  const control = makeControl();
  const { port, teardown } = await startUdpAssociation({
    control,
    clientIp: '127.0.0.1',
    bindAddress: '127.0.0.1',
    link,
    manager,
    log: silent,
  });
  assert.ok(port > 0);
  assert.equal(flows, 1);
  teardown('test done');
  assert.equal(flows, 0);
  teardown('double teardown is a no-op');
  assert.equal(flows, 0);
});
