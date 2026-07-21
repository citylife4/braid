import test from 'node:test';
import assert from 'node:assert/strict';
import { createPicker } from '../src/dispatch.js';

function fakeManager(strategy, links) {
  return {
    strategy,
    links: links.map((link) => ({
      up: true,
      enabled: true,
      weight: 1,
      active: 0,
      latency: null,
      current: 0,
      ...link,
    })),
  };
}

test('adaptive favors the fast, lightly-loaded link', () => {
  const manager = fakeManager('adaptive', [
    { name: 'powerline', latency: 60, active: 1 },
    { name: 'wifi', latency: 12, active: 1 },
  ]);
  const pick = createPicker(manager);
  assert.equal(pick().name, 'wifi');

  // Pile connections onto the fast link and it stops winning every time.
  manager.links[1].active = 12;
  assert.equal(pick().name, 'powerline');
});

test('adaptive respects weights and survives unknown latency', () => {
  const manager = fakeManager('adaptive', [
    { name: 'a', latency: null, active: 0, weight: 1 },
    { name: 'b', latency: null, active: 0, weight: 4 },
  ]);
  const pick = createPicker(manager);
  assert.equal(pick().name, 'b', 'equal unknown latency: higher weight wins');
});

test('adaptive skips down links and falls back when everything is down', () => {
  const manager = fakeManager('adaptive', [
    { name: 'dead', up: false, latency: 5 },
    { name: 'alive', latency: 40 },
  ]);
  const pick = createPicker(manager);
  assert.equal(pick().name, 'alive');

  manager.links[1].up = false;
  assert.ok(pick(), 'all links down: still returns a last-resort link');
});

test('balanced smooth weighted round-robin honors weights', () => {
  const manager = fakeManager('balanced', [
    { name: 'heavy', weight: 3 },
    { name: 'light', weight: 1 },
  ]);
  const pick = createPicker(manager);
  const sequence = Array.from({ length: 4 }, () => pick().name);
  assert.deepEqual(sequence.filter((name) => name === 'heavy').length, 3);
  assert.deepEqual(sequence.filter((name) => name === 'light').length, 1);
});
