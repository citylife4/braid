import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// "Start with Windows" for source launches (braid-gui.vbs / braid.cmd):
// a per-user Run registry entry that launches braid hidden at login. No admin
// needed — HKCU is writable by the user. The packaged desktop tray app manages
// its own Electron login item instead, so this module steps aside under it.
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Braid';

const launcher = fileURLToPath(new URL('../braid-gui.vbs', import.meta.url));

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { windowsHide: true }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout ?? '' });
    });
  });
}

export function createAutostart({ log }) {
  // Under the desktop tray app the Electron login item is the source of truth;
  // two competing registrations would be confusing.
  const supported = process.platform === 'win32'
    && process.env.ELECTRON_RUN_AS_NODE !== '1'
    && existsSync(launcher);

  // The Run value survives restarts, so read it once and cache; toggles keep
  // the cache in sync without a registry query per dashboard poll.
  let enabled = null;

  async function query() {
    const result = await reg(['query', RUN_KEY, '/v', RUN_VALUE]);
    enabled = result.ok;
    return enabled;
  }
  if (supported) query();

  const command = `wscript.exe "${launcher}" /startup`;

  return {
    status() {
      return { supported, enabled: supported ? Boolean(enabled) : false };
    },
    async setEnabled(next) {
      if (!supported) return { ok: false, error: 'startup registration is not available in this mode' };
      const result = next
        ? await reg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f'])
        : await reg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
      // Deleting an entry that does not exist is still "disabled" — only
      // report failures that leave us out of the requested state.
      if (!result.ok && next) {
        log.warn('autostart: could not write the Run registry entry');
        return { ok: false, error: 'could not write the Windows startup entry' };
      }
      await query();
      if (Boolean(enabled) !== next) {
        return { ok: false, error: 'the Windows startup entry did not change' };
      }
      log.info(`autostart: braid will ${next ? 'now' : 'no longer'} start with Windows`);
      return { ok: true, enabled: Boolean(enabled) };
    },
  };
}
