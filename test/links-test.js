import test from 'node:test';
import assert from 'node:assert/strict';
import { isVirtualInterfaceName } from '../src/links.js';

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
