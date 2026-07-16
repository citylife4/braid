import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron';
import { captureShutdownAction, captureStartupAction } from './capture-shutdown.js';

const APP_ID = 'com.citylife4.braid';
const PROXY_PORT = Number(process.env.BRAID_PROXY_PORT ?? 1080);
const DASHBOARD_PORT = Number(process.env.BRAID_DASHBOARD_PORT ?? 8181);
const DASHBOARD_URL = `http://127.0.0.1:${DASHBOARD_PORT}`;
const SMOKE_TEST = process.env.BRAID_SMOKE_TEST === '1';
const SMOKE_LOGIN_ITEM = process.env.BRAID_SMOKE_LOGIN_ITEM === '1';
const SMOKE_WINDOW = process.env.BRAID_SMOKE_WINDOW === '1';
const STARTUP_LAUNCH = process.argv.includes('--startup');
const START_TIMEOUT = 30000;

let tray = null;
let dashboardWindow = null;
let dashboardWindowReady = null;
let logFile = null;
let preferencesFile = null;
let monitor = null;
let allowQuit = false;
let quitInProgress = false;
let captureTransition = null;

const preferences = {
  autoCapture: true,
};

const service = {
  child: null,
  mode: 'stopped', // stopped | child | attached
  transition: false,
  stopping: false,
  expectedExit: false,
  lastError: null,
};

// Keep packaged smoke tests isolated from a real Braid instance that may be
// protecting the machine's active capture session.
if (SMOKE_TEST) app.setPath('userData', path.join(process.env.TEMP ?? process.cwd(), 'Braid Smoke Test'));

app.setAppUserModelId(APP_ID);
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    app.whenReady().then(() => { openDashboard(); });
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeLog(message) {
  if (!logFile) return;
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try { await appendFile(logFile, line, 'utf8'); } catch {}
}

async function loadPreferences() {
  preferencesFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    const saved = JSON.parse(await readFile(preferencesFile, 'utf8'));
    if (typeof saved.autoCapture === 'boolean') preferences.autoCapture = saved.autoCapture;
  } catch (error) {
    if (error.code !== 'ENOENT') await writeLog(`could not read settings: ${error.message}`);
  }
}

async function savePreferences() {
  if (!preferencesFile) return;
  await mkdir(path.dirname(preferencesFile), { recursive: true });
  await writeFile(preferencesFile, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
}

async function reportAutomaticCaptureError(error) {
  await writeLog(`automatic capture startup failed: ${error.stack ?? error.message}`);
  if (SMOKE_TEST) return;
  if (STARTUP_LAUNCH) {
    showBalloon('System-wide capture is off', error.message, 'error');
    return;
  }
  await dialog.showMessageBox({
    type: 'warning',
    title: 'System-wide capture did not start',
    message: 'Braid is running in proxy-only mode.',
    detail: error.message,
  });
}

async function toggleAutomaticCapture(enabled) {
  preferences.autoCapture = enabled;
  try {
    await savePreferences();
    rebuildMenu();
    if (enabled && isRunning()) await enableCaptureForStartup();
  } catch (error) {
    await reportAutomaticCaptureError(error);
  }
}

async function request(pathname, options = {}, timeout = 1800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${DASHBOARD_URL}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers ?? {}),
        ...(options.method === 'POST' ? { 'content-type': 'application/json', 'x-braid': '1' } : {}),
      },
    });
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw new Error(body?.error ?? `Braid returned HTTP ${response.status}.`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function getStats() {
  try {
    const stats = await request('/api/stats');
    return stats?.version ? stats : null;
  } catch {
    return null;
  }
}

function isRunning() {
  return service.mode !== 'stopped';
}

function createTrayImage() {
  // Windows' tray loader is most reliable with a raster image. Keeping this
  // tiny PNG embedded also makes portable builds independent of working paths.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA30lEQVR4nNXVsRHCMBBEUbdARgf0QUBEBZRGOw6JqcdEnjHynbx7uxoGz1wE+D8jCabpn67T+bIg87OwHVINWyCV0PX13k0J4QhHEDi+lathChHd2BGGl0MNSADnE2b36p4MdW2R/ZIClJ1t+X2onO37c/maYYB22rACoQBH4QoEArBhBpIC1CiKkQCOz5QAyl6RAOwRswFu82M3VUgKiBBRWIF04y0AibOQ9n3df0QW0INEr4dxBwAFpoAVwTwVC+jG14tZV2ageLscLggVryAyCPy1OyHQZhsJsYdHXh9nqY8cORCdHQAAAABJRU5ErkJggg==';
  return nativeImage.createFromDataURL(`data:image/png;base64,${png}`).resize({ width: 16, height: 16, quality: 'best' });
}

function destroyDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) dashboardWindow.destroy();
  dashboardWindow = null;
  dashboardWindowReady = null;
}

function createDashboardWindow() {
  const window = new BrowserWindow({
    title: 'Braid',
    width: 1100,
    height: 760,
    minWidth: 680,
    minHeight: 520,
    show: false,
    center: true,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== `${DASHBOARD_URL}/`) event.preventDefault();
  });
  window.on('close', (event) => {
    if (!allowQuit) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (dashboardWindow === window) {
      dashboardWindow = null;
      dashboardWindowReady = null;
    }
  });
  return window;
}

async function showDashboardWindow({ show = true } = {}) {
  if (!isRunning()) await startService();
  if (!dashboardWindow || dashboardWindow.isDestroyed()) {
    dashboardWindow = createDashboardWindow();
    const window = dashboardWindow;
    dashboardWindowReady = window.loadURL(`${DASHBOARD_URL}/`).catch((error) => {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    });
  }
  await dashboardWindowReady;
  const window = dashboardWindow;
  if (!window || window.isDestroyed()) throw new Error('The Braid window closed before it was ready.');
  if (show) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
  return window;
}

function loginItemOptions(openAtLogin) {
  const portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged) {
    return {
      openAtLogin,
      path: portableExecutable || process.execPath,
      args: ['--startup'],
      name: 'Braid',
    };
  }
  return {
    openAtLogin,
    path: process.execPath,
    args: [app.getAppPath(), '--startup'],
    name: 'Braid Development',
  };
}

function startsWithWindows() {
  const { path: executable, args } = loginItemOptions(false);
  const settings = app.getLoginItemSettings({ path: executable, args });
  return settings.executableWillLaunchAtLogin ?? settings.openAtLogin;
}

function setStartsWithWindows(enabled) {
  app.setLoginItemSettings({ ...loginItemOptions(enabled), enabled });
  rebuildMenu();
}

function toggleStartsWithWindows(enabled) {
  try {
    setStartsWithWindows(enabled);
  } catch (error) {
    rebuildMenu();
    dialog.showMessageBox({
      type: 'error',
      title: 'Startup setting was not changed',
      message: 'Braid could not update the Windows startup setting.',
      detail: error.message,
    });
  }
}

function updateTray() {
  if (!tray) return;
  const label = service.transition
    ? 'Braid — changing state…'
    : isRunning()
      ? 'Braid — running'
      : service.lastError
        ? 'Braid — stopped with an error'
        : 'Braid — stopped';
  tray.setToolTip(label);
  rebuildMenu();
}

function rebuildMenu() {
  if (!tray) return;
  const running = isRunning();
  const menu = Menu.buildFromTemplate([
    { label: service.transition ? 'Changing state…' : running ? 'Braid is running' : 'Braid is stopped', enabled: false },
    { label: 'Open Braid', enabled: !service.transition, click: () => { openDashboard(); } },
    { type: 'separator' },
    { label: 'Start Braid', enabled: !running && !service.transition, click: () => { startService({ notify: true }).catch(() => {}); } },
    { label: 'Stop Braid', enabled: running && !service.transition, click: () => { stopFromMenu(); } },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: startsWithWindows(),
      click: (item) => toggleStartsWithWindows(item.checked),
    },
    {
      label: 'Enable capture on launch',
      type: 'checkbox',
      checked: preferences.autoCapture,
      click: (item) => { toggleAutomaticCapture(item.checked); },
    },
    { type: 'separator' },
    { label: 'Quit Braid', click: () => { quitApplication(); } },
  ]);
  tray.setContextMenu(menu);
}

function showBalloon(title, content, iconType = 'info') {
  if (!tray || SMOKE_TEST) return;
  tray.displayBalloon({ title, content, iconType, noSound: true, respectQuietTime: true });
}

async function waitForReady() {
  const deadline = Date.now() + START_TIMEOUT;
  while (Date.now() < deadline) {
    const stats = await getStats();
    if (stats) return stats;
    if (service.lastError) throw new Error(service.lastError);
    if (service.child?.exitCode != null) throw new Error(`Braid exited with code ${service.child.exitCode}.`);
    await delay(250);
  }
  throw new Error('Braid did not become ready within 30 seconds.');
}

function attachChildLogging(child) {
  child.stdout?.on('data', (chunk) => { writeLog(chunk.toString().trimEnd()); });
  child.stderr?.on('data', (chunk) => { writeLog(`ERROR ${chunk.toString().trimEnd()}`); });
}

async function startService({ notify = false } = {}) {
  if (service.transition || isRunning()) return getStats();
  service.transition = true;
  service.lastError = null;
  updateTray();
  try {
    const existing = await getStats();
    if (existing) {
      service.mode = 'attached';
      await writeLog(`attached to existing Braid dashboard on port ${DASHBOARD_PORT}`);
      if (notify) showBalloon('Braid is running', 'Attached to the existing Braid service.');
      return existing;
    }

    const appRoot = app.getAppPath();
    const root = appRoot.endsWith('app.asar') ? `${appRoot}.unpacked` : appRoot;
    const cli = path.join(root, 'bin', 'braid.js');
    const child = spawn(process.execPath, [
      cli,
      '--port', String(PROXY_PORT),
      '--dashboard', String(DASHBOARD_PORT),
    ], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    service.child = child;
    service.mode = 'child';
    service.expectedExit = false;
    attachChildLogging(child);
    child.once('error', (error) => {
      service.lastError = error.message;
      writeLog(`service process error: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      const expected = service.stopping || service.expectedExit;
      service.child = null;
      service.mode = 'stopped';
      service.transition = false;
      service.stopping = false;
      service.expectedExit = false;
      if (!expected && !allowQuit) {
        service.lastError = `Braid stopped unexpectedly (${signal ?? `exit ${code}`}).`;
        writeLog(service.lastError);
        showBalloon('Braid stopped', service.lastError, 'error');
      }
      destroyDashboardWindow();
      updateTray();
    });

    const stats = await waitForReady();
    await writeLog(`service ready: proxy ${PROXY_PORT}, dashboard ${DASHBOARD_PORT}`);
    if (notify) showBalloon('Braid is running', `Proxy ${PROXY_PORT} · dashboard ${DASHBOARD_PORT}`);
    return stats;
  } catch (error) {
    service.lastError = error.message;
    await writeLog(`start failed: ${error.stack ?? error.message}`);
    const failedChild = service.child;
    if (failedChild && failedChild.exitCode == null) {
      service.expectedExit = true;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        failedChild.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        failedChild.kill();
      });
    }
    if (service.child === failedChild) service.child = null;
    service.mode = 'stopped';
    if (notify) showBalloon('Braid could not start', error.message, 'error');
    throw error;
  } finally {
    service.transition = false;
    updateTray();
  }
}

async function waitForStop() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (!(await getStats())) return;
    await delay(200);
  }
  throw new Error('Braid did not stop cleanly.');
}

async function waitForCaptureDisabled(startedAt) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const stats = await getStats();
    if (!stats) throw new Error('The Braid service stopped before capture cleanup finished.');
    const capture = stats.capture;
    if (captureShutdownAction(capture) === 'none') return;
    const resultAt = Date.parse(capture?.lastResult?.at ?? '');
    if (capture?.lastResult?.ok === false && Number.isFinite(resultAt) && resultAt >= startedAt - 1000) {
      throw new Error(capture.lastResult.message ?? 'Windows could not disable system-wide capture.');
    }
    await delay(500);
  }
  throw new Error('Timed out while waiting for Windows to restore normal routing.');
}

async function waitForCaptureEnabled(startedAt) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const stats = await getStats();
    if (!stats) throw new Error('The Braid service stopped before capture startup finished.');
    const capture = stats.capture;
    if (capture?.active && capture.ownership === 'this') return capture;
    const resultAt = Date.parse(capture?.lastResult?.at ?? '');
    if (capture?.lastResult?.ok === false && Number.isFinite(resultAt) && resultAt >= startedAt - 1000) {
      throw new Error(capture.lastResult.message ?? 'Windows could not start system-wide capture.');
    }
    if (capture?.ownership === 'other') {
      throw new Error(`Capture became managed by another Braid proxy on port ${capture.ownerProxyPort}.`);
    }
    await delay(500);
  }
  throw new Error('Timed out while waiting for the Braid network adapter to start.');
}

async function enableCaptureForStartupNow() {
  const stats = await getStats();
  if (!stats?.capture) throw new Error('The Braid service is not ready.');
  const action = captureStartupAction(stats.capture);
  if (action === 'ready') return stats.capture;
  if (action === 'leave') {
    await writeLog(`capture startup skipped because proxy port ${stats.capture.ownerProxyPort} owns it`);
    return stats.capture;
  }
  if (action === 'manual') {
    throw new Error('An incomplete or unverified capture session needs cleanup in the dashboard.');
  }

  showBalloon('Braid needs approval', 'Approve the Windows prompt to enable system-wide capture.');
  await writeLog('automatically enabling system-wide capture on launch');
  const startedAt = Date.now();
  const result = await request('/api/capture/enable', { method: 'POST', body: '{}' }, 60000);
  if (!result?.ok) throw new Error(result?.error ?? 'Windows did not approve capture startup.');
  const capture = await waitForCaptureEnabled(startedAt);
  await writeLog('system-wide capture started automatically');
  showBalloon('System-wide capture is on', 'Windows apps are now routed through Braid.');
  return capture;
}

async function enableCaptureForStartup() {
  if (captureTransition) return captureTransition;
  captureTransition = enableCaptureForStartupNow();
  try {
    return await captureTransition;
  } finally {
    captureTransition = null;
  }
}

async function disableCaptureForShutdown() {
  if (captureTransition) {
    await writeLog('waiting for capture startup to finish before shutdown');
    try { await captureTransition; } catch {}
  }
  const stats = await getStats();
  if (!stats?.capture) return;
  const action = captureShutdownAction(stats.capture);
  if (action === 'none' || action === 'leave') return;
  if (action === 'manual') {
    throw new Error('Capture ownership could not be verified. Use the dashboard to clean it up before quitting.');
  }

  showBalloon('Braid needs approval', 'Approve the Windows prompt to restore normal routing before Braid stops.');
  await writeLog(`automatically disabling ${stats.capture.ownership} capture before shutdown`);
  const startedAt = Date.now();
  const result = await request('/api/capture/disable', { method: 'POST', body: '{}' }, 60000);
  if (!result?.ok) throw new Error(result?.error ?? 'Windows did not approve capture shutdown.');
  await waitForCaptureDisabled(startedAt);
  await writeLog('capture disabled automatically; normal routing restored');
}

async function stopService() {
  if (service.transition) throw new Error('Braid is already changing state. Please wait and try again.');
  if (!isRunning()) return;
  service.transition = true;
  service.stopping = true;
  updateTray();
  try {
    await disableCaptureForShutdown();
    await request('/api/quit', { method: 'POST', body: '{}' }, 5000);
    await waitForStop();
    service.child = null;
    service.mode = 'stopped';
    service.lastError = null;
    destroyDashboardWindow();
    await writeLog('service stopped cleanly');
  } catch (error) {
    service.stopping = false;
    await writeLog(`stop refused: ${error.message}`);
    throw error;
  } finally {
    service.transition = false;
    service.stopping = false;
    updateTray();
  }
}

async function openDashboard() {
  try {
    await showDashboardWindow();
  } catch (error) {
    if (!SMOKE_TEST) dialog.showErrorBox('Braid could not start', error.message);
  }
}

async function stopFromMenu() {
  try {
    await stopService();
    showBalloon('Braid stopped', 'The proxy and dashboard have stopped.');
  } catch (error) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Braid is still running',
      message: 'Braid could not stop safely.',
      detail: error.message,
    });
  }
}

async function quitApplication() {
  if (quitInProgress) return;
  quitInProgress = true;
  try {
    if (isRunning()) await stopService();
    allowQuit = true;
    app.quit();
  } catch (error) {
    quitInProgress = false;
    dialog.showMessageBox({
      type: 'warning',
      title: 'Braid could not quit safely',
      message: 'Braid is still running so your network connection remains protected.',
      detail: error.message,
    });
  }
}

async function runSmokeTest(image) {
  try {
    const stats = await startService();
    if (image.isEmpty()) throw new Error('tray icon is empty');
    let windowUrl = null;
    let windowTitle = null;
    if (SMOKE_WINDOW) {
      const window = await showDashboardWindow({ show: false });
      windowUrl = window.webContents.getURL();
      windowTitle = window.webContents.getTitle();
      if (windowUrl !== `${DASHBOARD_URL}/`) throw new Error(`standalone window loaded an unexpected URL: ${windowUrl}`);
      if (!/braid/i.test(windowTitle)) throw new Error(`standalone window has an unexpected title: ${windowTitle}`);
      window.close();
      await delay(50);
      if (window.isDestroyed()) throw new Error('closing the dashboard window did not preserve the tray app');
      if (window.isVisible()) throw new Error('closing the dashboard window did not hide it');
      if (await showDashboardWindow({ show: false }) !== window) throw new Error('the tray app did not reuse its dashboard window');
      destroyDashboardWindow();
      await writeLog('standalone dashboard window and close-to-tray smoke test passed');
    }
    let loginItemRoundTrip = null;
    if (SMOKE_LOGIN_ITEM) {
      const previous = startsWithWindows();
      try {
        setStartsWithWindows(!previous);
        if (startsWithWindows() !== !previous) {
          const { path: executable, args } = loginItemOptions(false);
          const detail = app.getLoginItemSettings({ path: executable, args });
          throw new Error(`startup registration did not change: ${JSON.stringify(detail)}`);
        }
        loginItemRoundTrip = true;
      } finally {
        setStartsWithWindows(previous);
      }
      if (startsWithWindows() !== previous) throw new Error('startup registration was not restored');
      await writeLog('startup registration round-trip passed and was restored');
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: stats.version,
      links: stats.links.length,
      proxy: stats.proxy,
      dashboard: DASHBOARD_PORT,
      windowUrl,
      windowTitle,
      autoCaptureOnLaunch: preferences.autoCapture,
      loginItemRoundTrip,
    })}\n`);
    await stopService();
    allowQuit = true;
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    try { if (isRunning()) await stopService(); } catch {}
    allowQuit = true;
    app.exit(1);
  }
}

app.on('before-quit', (event) => {
  if (!allowQuit) {
    event.preventDefault();
    quitApplication();
  }
});
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  app.setAppLogsPath();
  const logs = app.getPath('logs');
  await mkdir(logs, { recursive: true });
  logFile = path.join(logs, 'braid-service.log');
  await writeLog(`desktop host starting${SMOKE_TEST ? ' (smoke test)' : ''}`);
  await loadPreferences();

  const image = createTrayImage();
  if (image.isEmpty()) throw new Error('could not create the tray icon');
  tray = new Tray(image);
  tray.on('double-click', () => { openDashboard(); });
  updateTray();

  if (SMOKE_TEST) {
    await runSmokeTest(image);
    return;
  }

  try {
    await startService();
    if (!STARTUP_LAUNCH) await showDashboardWindow();
    if (!SMOKE_TEST && preferences.autoCapture) {
      try { await enableCaptureForStartup(); } catch (error) { await reportAutomaticCaptureError(error); }
    }
  } catch (error) {
    await writeLog(`initial start failed: ${error.stack ?? error.message}`);
    dialog.showErrorBox('Braid could not start', `${error.message}\n\nSee ${logFile} for details.`);
  }

  monitor = setInterval(async () => {
    if (service.transition) return;
    const stats = await getStats();
    if (!stats && service.mode === 'attached') {
      service.mode = 'stopped';
      service.lastError = 'The attached Braid service stopped.';
      destroyDashboardWindow();
      updateTray();
    }
  }, 5000);
}).catch(async (error) => {
  await writeLog(`fatal desktop error: ${error.stack ?? error.message}`);
  process.stderr.write(`${error.stack ?? error.message}\n`);
  allowQuit = true;
  app.exit(1);
});

app.on('will-quit', () => {
  if (monitor) clearInterval(monitor);
  tray?.destroy();
});
