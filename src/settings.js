import path from 'node:path';
import os from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Small persistent settings for the core braid service (the Electron shell
// keeps its own preferences separately). GUI changes that a user expects to
// survive a restart — Wi-Fi assist, the bonding-server config — live here.
// CLI flags always win for the run they are given on, and are never saved.
function settingsDir() {
  if (process.env.BRAID_SETTINGS_DIR) return process.env.BRAID_SETTINGS_DIR; // tests
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'braid');
  return path.join(os.homedir(), '.config', 'braid');
}

const file = () => path.join(settingsDir(), 'settings.json');

export function loadSettings(log) {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') log?.warn(`settings: could not read ${file()}: ${err.message}`);
    return {};
  }
}

export function saveSettings(patch, log) {
  const merged = { ...loadSettings(log), ...patch };
  for (const key of Object.keys(merged)) {
    if (merged[key] === null || merged[key] === undefined) delete merged[key];
  }
  try {
    mkdirSync(settingsDir(), { recursive: true });
    writeFileSync(file(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  } catch (err) {
    log?.warn(`settings: could not write ${file()}: ${err.message}`);
  }
  return merged;
}
