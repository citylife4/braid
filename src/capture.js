import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptDir = fileURLToPath(new URL('../engine/', import.meta.url));
const dataDir = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'braid');
const engineDir = path.join(dataDir, 'engine');
const resultFile = path.join(engineDir, 'capture.result.json');
const stateFile = path.join(dataDir, 'capture-state.json');
const ADAPTER = 'braid';

function readJson(file) {
  try {
    // Windows PowerShell 5 writes a UTF-8 BOM. JSON.parse does not accept it.
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Access denied still proves the process exists; only ESRCH proves it does
    // not. Stay conservative for every other platform-specific error.
    return err.code === 'ESRCH' ? false : true;
  }
}

// System-wide capture = Wintun adapter + tun2socks feeding braid's SOCKS
// port. Both need Administrator rights, so braid (running unprivileged) only
// *launches* the elevated scripts — Windows shows the user a UAC prompt and
// the user stays in charge of the trust decision.
export function createCapture({ proxyPort, dashboardPort = 0, log }) {
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
    const adapterUp = Object.hasOwn(os.networkInterfaces(), ADAPTER);
    const active = engineRunning && adapterUp;
    const present = engineRunning || adapterUp;
    const state = present ? readJson(stateFile) : null;
    const ownerProxyPort = Number(state?.proxyPort) || null;
    const ownerRunning = processIsRunning(Number(state?.braidPid));
    const ownership = !present
      ? 'none'
      : ownerProxyPort === proxyPort
        ? 'this'
        : ownerProxyPort && ownerRunning === false
          ? 'orphaned'
          : ownerProxyPort
            ? 'other'
            : 'unknown';
    return {
      staged: existsSync(path.join(engineDir, 'tun2socks.exe')) && existsSync(path.join(engineDir, 'wintun.dll')),
      engineRunning,
      adapterUp,
      active,
      ownership,
      ownerProxyPort,
      ownerDashboardPort: Number(state?.dashboardPort) || null,
      ownerRunning,
      lastResult: readJson(resultFile),
    };
  }

  function runElevated(script, extraArgs = []) {
    return new Promise((resolve) => {
      const file = path.join(scriptDir, script);
      if (!existsSync(file)) {
        resolve({ ok: false, error: `${script} is missing` });
        return;
      }
      // Run the elevated script with a hidden window (-WindowStyle Hidden) and
      // pass -Hidden so it reports through the persistent ProgramData engine
      // directory instead of waiting on a keypress. The UAC prompt itself
      // still shows — that's the user's trust gate — but no console lingers.
      const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', file, ...extraArgs, '-Hidden'];
      const list = inner.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
      const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList @(${list})`;
      execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], { windowsHide: true }, (err, _stdout, stderr) => {
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
      return runElevated('enable-capture.ps1', [
        '-DataDir', engineDir,
        '-ProxyPort', String(proxyPort),
        '-DashboardPort', String(dashboardPort),
        '-BraidPid', String(process.pid),
      ]);
    },
    disable: () => {
      log.info('capture: launching elevated disable script (answer the UAC prompt)');
      return runElevated('disable-capture.ps1', ['-DataDir', engineDir]);
    },
  };
}
