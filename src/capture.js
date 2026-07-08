import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const engineDir = fileURLToPath(new URL('../engine/', import.meta.url));
const ADAPTER = 'braid';

// System-wide capture = Wintun adapter + tun2socks feeding braid's SOCKS
// port. Both need Administrator rights, so braid (running unprivileged) only
// *launches* the elevated scripts — Windows shows the user a UAC prompt and
// the user stays in charge of the trust decision.
export function createCapture({ proxyPort, log }) {
  let engineRunning = false;
  let lastProcessCheck = 0;
  let checking = false;

  function refreshProcess() {
    if (checking || Date.now() - lastProcessCheck < 5000) return;
    checking = true;
    execFile('tasklist', ['/FI', 'IMAGENAME eq tun2socks.exe', '/FO', 'CSV', '/NH'], (err, stdout) => {
      checking = false;
      lastProcessCheck = Date.now();
      engineRunning = !err && /tun2socks\.exe/i.test(stdout ?? '');
    });
  }

  function status() {
    refreshProcess();
    return {
      staged: existsSync(path.join(engineDir, 'tun2socks.exe')) && existsSync(path.join(engineDir, 'wintun.dll')),
      engineRunning,
      adapterUp: Object.hasOwn(os.networkInterfaces(), ADAPTER),
    };
  }

  function runElevated(script, extraArgs = []) {
    return new Promise((resolve) => {
      const file = path.join(engineDir, script);
      if (!existsSync(file)) {
        resolve({ ok: false, error: `${script} is missing` });
        return;
      }
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...extraArgs];
      const list = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
      const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(${list})`;
      execFile('powershell.exe', ['-NoProfile', '-Command', command], (err, _stdout, stderr) => {
        lastProcessCheck = 0; // re-check the engine process soon
        if (err) {
          const cancelled = /canceled|cancelled|abgebrochen|cancelado/i.test(stderr ?? '');
          log.warn(`capture: elevation ${cancelled ? 'declined by user' : `failed: ${stderr?.trim() || err.message}`}`);
          resolve({ ok: false, error: cancelled ? 'UAC prompt was declined' : 'elevation failed' });
          return;
        }
        resolve({ ok: true, pending: true });
      });
    });
  }

  return {
    status,
    enable: () => {
      log.info('capture: launching elevated enable script (answer the UAC prompt)');
      return runElevated('enable-capture.ps1', ['-ProxyPort', String(proxyPort)]);
    },
    disable: () => {
      log.info('capture: launching elevated disable script (answer the UAC prompt)');
      return runElevated('disable-capture.ps1');
    },
  };
}
