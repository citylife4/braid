import test from 'node:test';
import assert from 'node:assert/strict';
import { isVirtualInterfaceName, LinkManager } from '../src/links.js';

test('recognizes common overlay and VM adapters', () => {
  for (const name of [
    'Tailscale',
    'Tailscale Tunnel',
    'vEthernet (Default Switch)',
    'WSL',
    'Docker Desktop Network',
    'VMware Network Adapter VMnet1',
    'VirtualBox Host-Only Network',
    'ZeroTier One',
    'WireGuard Tunnel',
    'NordLynx',
    'Npcap Loopback Adapter',
  ]) {
    assert.equal(isVirtualInterfaceName(name), true, name);
  }
});

test('keeps physical and hotspot interfaces eligible', () => {
  for (const name of ['Ethernet', 'Ethernet 2', 'Wi-Fi', 'Local Area Connection', 'iPhone USB']) {
    assert.equal(isVirtualInterfaceName(name), false, name);
  }
});

test('setWeight updates a link and validates its input', () => {
  const manager = new LinkManager([{ name: 'Ethernet', address: '127.0.0.1' }]);
  assert.equal(manager.links[0].weight, 1);

  assert.deepEqual(manager.setWeight('Ethernet', 3), { ok: true, name: 'Ethernet', weight: 3 });
  assert.equal(manager.links[0].weight, 3);
  assert.match(manager.events.at(-1).message, /weight set to 3/);

  assert.equal(manager.setWeight('Ethernet', 0).ok, false);
  assert.equal(manager.setWeight('Ethernet', 101).ok, false);
  assert.equal(manager.setWeight('Ethernet', 'lots').ok, false);
  assert.equal(manager.setWeight('no-such-link', 2).ok, false);
  assert.equal(manager.links[0].weight, 3, 'rejected updates must not change the weight');
});

test('resolveHost caches successful lookups', async () => {
  const manager = new LinkManager([{ name: 'Ethernet', address: '127.0.0.1' }]);
  let calls = 0;
  manager.links[0].resolver = {
    resolve4: async () => {
      calls += 1;
      return ['192.0.2.10'];
    },
  };

  assert.equal(await manager.resolveHost('example.com'), '192.0.2.10');
  assert.equal(await manager.resolveHost('example.com'), '192.0.2.10');
  assert.equal(calls, 1, 'the second resolve must be served from the cache');
});
