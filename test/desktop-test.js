import test from 'node:test';
import assert from 'node:assert/strict';
import { captureIsPresent, captureShutdownAction, captureStartupAction } from '../desktop/capture-shutdown.js';

test('detects partial and fully active capture states', () => {
  assert.equal(captureIsPresent({ engineRunning: false, adapterUp: false }), false);
  assert.equal(captureIsPresent({ engineRunning: true, adapterUp: false }), true);
  assert.equal(captureIsPresent({ engineRunning: false, adapterUp: true }), true);
});

test('automatically disables capture owned by this or an orphaned Braid instance', () => {
  assert.equal(captureShutdownAction({ engineRunning: true, adapterUp: true, ownership: 'this' }), 'disable');
  assert.equal(captureShutdownAction({ engineRunning: true, adapterUp: true, ownership: 'orphaned' }), 'disable');
});

test('preserves capture owned by another running Braid instance', () => {
  assert.equal(captureShutdownAction({ engineRunning: true, adapterUp: true, ownership: 'other' }), 'leave');
});

test('requires manual cleanup when ownership cannot be established', () => {
  assert.equal(captureShutdownAction({ engineRunning: true, adapterUp: true, ownership: 'unknown' }), 'manual');
  assert.equal(captureShutdownAction({ engineRunning: false, adapterUp: false, ownership: 'unknown' }), 'none');
});

test('starts capture when absent and accepts an active owned session', () => {
  assert.equal(captureStartupAction({ engineRunning: false, adapterUp: false, ownership: 'none' }), 'enable');
  assert.equal(captureStartupAction({ engineRunning: true, adapterUp: true, active: true, ownership: 'this' }), 'ready');
});

test('does not replace another owner or a partial capture session automatically', () => {
  assert.equal(captureStartupAction({ engineRunning: true, adapterUp: true, active: true, ownership: 'other' }), 'leave');
  assert.equal(captureStartupAction({ engineRunning: true, adapterUp: false, active: false, ownership: 'this' }), 'manual');
  assert.equal(captureStartupAction({ engineRunning: true, adapterUp: true, active: true, ownership: 'unknown' }), 'manual');
});
