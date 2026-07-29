import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { parseUdpPacket, startUdpAssociation } from '../src/udp.js';

function ipv4Packet(port, data = Buffer.from('payload'), address = [203, 0, 113, 50]) {
  const packet = Buffer.alloc(10 + data.length);
  packet[3] = 0x01;
  packet.set(address, 4);
  packet.writeUInt16BE(port, 8);
  data.copy(packet, 10);
  return packet;
}

function domainPacket(port, name = 'example.com', data = Buffer.from('payload')) {
  const encoded = Buffer.from(name);
  const packet = Buffer.alloc(5 + encoded.length + 2 + data.length);
  packet[3] = 0x03;
  packet[4] = encoded.length;
  encoded.copy(packet, 5);
  packet.writeUInt16BE(port, 5 + encoded.length);
  data.copy(packet, 5 + encoded.length + 2);
  return packet;
}

test('parses valid IPv4 and domain UDP destinations', () => {
  assert.deepEqual(parseUdpPacket(ipv4Packet(6881)), {
    host: '203.0.113.50',
    port: 6881,
    data: Buffer.from('payload'),
    isDomain: false,
  });
  assert.deepEqual(parseUdpPacket(domainPacket(443)), {
    host: 'example.com',
    port: 443,
    data: Buffer.from('payload'),
    isDomain: true,
  });
});

test('drops zero-port UDP destinations instead of passing them to dgram.send', () => {
  assert.equal(parseUdpPacket(ipv4Packet(0)), null);
  assert.equal(parseUdpPacket(domainPacket(0)), null);
});

test('drops fragmented and truncated UDP packets', () => {
  const fragmented = ipv4Packet(53);
  fragmented[2] = 1;
  assert.equal(parseUdpPacket(fragmented), null);

  assert.equal(parseUdpPacket(domainPacket(53).subarray(0, 8)), null);
});

test('UDP relay survives a zero-port packet and handles the next datagram', async () => {
  const echo = dgram.createSocket('udp4');
  await new Promise((resolve) => echo.bind(0, '127.0.0.1', resolve));
  echo.on('message', (message, remote) => echo.send(message, remote.port, remote.address));

  const control = new EventEmitter();
  let controlDestroyed = false;
  control.destroy = () => {
    if (controlDestroyed) return;
    controlDestroyed = true;
    control.emit('close');
  };

  let tracked = 0;
  const manager = {
    trackUdp: () => { tracked += 1; },
    untrackUdp: () => { tracked -= 1; },
    resolveHost: async () => '127.0.0.1',
  };
  const log = { debug() {} };
  const client = dgram.createSocket('udp4');
  let teardown;

  try {
    const association = await startUdpAssociation({
      control,
      clientIp: '127.0.0.1',
      bindAddress: '127.0.0.1',
      link: { name: 'test', address: '127.0.0.1', bytesIn: 0, bytesOut: 0 },
      manager,
      log,
    });
    teardown = association.teardown;
    assert.equal(tracked, 1);

    client.send(ipv4Packet(0), association.port, '127.0.0.1');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(controlDestroyed, false, 'malformed packet must not close the association');

    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UDP relay reply timed out')), 1000);
      client.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    const payload = Buffer.from('still alive');
    client.send(ipv4Packet(echo.address().port, payload, [127, 0, 0, 1]), association.port, '127.0.0.1');
    const message = await reply;
    assert.deepEqual(message.subarray(10), payload);
  } finally {
    teardown?.('test complete');
    try { client.close(); } catch {}
    try { echo.close(); } catch {}
  }

  assert.equal(tracked, 0);
});
