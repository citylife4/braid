import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.BRAID_SETTINGS_DIR = mkdtempSync(path.join(os.tmpdir(), 'braid-settings-'));
const { loadSettings, saveSettings } = await import('../src/settings.js');

test.after(() => rmSync(process.env.BRAID_SETTINGS_DIR, { recursive: true, force: true }));

test('load returns an empty object before anything is saved', () => {
  assert.deepEqual(loadSettings(), {});
});

test('save merges patches and null deletes a key', () => {
  saveSettings({ wifiAssist: true });
  saveSettings({ tunnel: { host: 'vps.example.com', port: 7000, secret: 's3cret' } });
  assert.deepEqual(loadSettings(), {
    wifiAssist: true,
    tunnel: { host: 'vps.example.com', port: 7000, secret: 's3cret' },
  });

  saveSettings({ tunnel: null });
  assert.deepEqual(loadSettings(), { wifiAssist: true });

  const raw = readFileSync(path.join(process.env.BRAID_SETTINGS_DIR, 'settings.json'), 'utf8');
  assert.ok(raw.endsWith('\n'), 'file ends with a newline');
});
