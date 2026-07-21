import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Wi-Fi assist: keep the wireless link in the bond even when Ethernet is up.
//
// Windows treats Ethernet as "good enough" and will not auto-connect (and with
// the default WCM group policy will even soft-disconnect) Wi-Fi while a wired
// connection has internet. A bonder wants the opposite: every link connected.
// When enabled, this loop watches the WLAN adapter and, whenever it sits
// disconnected, connects it to the best saved profile that is currently in
// range. Plain user rights are enough — netsh wlan connect needs no admin.
//
// The deeper OS-level fix (stop Windows from soft-disconnecting Wi-Fi in the
// first place) is scripts/allow-wifi-with-ethernet.ps1, which needs admin.
const CHECK_MS = 20000; // how often to look at the WLAN state
const CONNECT_COOLDOWN_MS = 45000; // min gap between connect attempts
const EXEC_TIMEOUT_MS = 15000;

// The WCM group policy that makes Windows soft-disconnect Wi-Fi while
// Ethernet has internet. 0 = keep Wi-Fi connected (what a bonder wants).
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WcmSvc\\GroupPolicy';
const POLICY_VALUE = 'fMinimizeConnections';
const policyScript = fileURLToPath(new URL('../scripts/allow-wifi-with-ethernet.ps1', import.meta.url));

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout ?? '' });
    });
  });
}

// "applied" when the policy explicitly tells Windows to keep Wi-Fi up
// alongside Ethernet; "default" otherwise (Windows may drop Wi-Fi).
async function queryPolicy() {
  const result = await run('reg', ['query', POLICY_KEY, '/v', POLICY_VALUE]);
  return result.ok && /0x0\s*$/m.test(result.stdout) ? 'applied' : 'default';
}

// Launch the policy script elevated (UAC prompt, hidden console) and wait for
// it to finish. Mirrors the capture scripts' elevation flow.
function runPolicyScriptElevated() {
  return new Promise((resolve) => {
    const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', policyScript, '-Hidden'];
    const list = inner.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(',');
    const command = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @(${list})`;
    execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], { windowsHide: true, timeout: 180000 }, (err, _stdout, stderr) => {
      if (err) {
        const cancelled = /canceled|cancelled|abgebrochen|cancelado/i.test(stderr ?? '');
        resolve({ ok: false, error: cancelled ? 'the Windows approval prompt was declined' : 'could not run the policy script elevated' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

// Adapter discovery goes through PowerShell CIM objects because their JSON is
// locale-independent, unlike netsh's translated labels.
// MediaConnectionState: 1 = connected, 2 = disconnected.
async function wlanAdapters() {
  const script = "Get-NetAdapter -Physical | Where-Object { $_.PhysicalMediaType -like '*802.11*' } | Select-Object Name, MediaConnectionState | ConvertTo-Json -Compress";
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (!result.ok || !result.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((adapter) => adapter && typeof adapter.Name === 'string')
      .map((adapter) => ({ name: adapter.Name, connected: Number(adapter.MediaConnectionState) === 1 }));
  } catch {
    return [];
  }
}

// netsh labels are localized ("All User Profile" / "Perfil de todos los
// usuarios" / "Perfil de Todos os Usuários"...), but they all contain
// "profil" and keep the "<label> : <value>" shape.
async function savedProfiles() {
  const result = await run('netsh', ['wlan', 'show', 'profiles']);
  if (!result.ok) return [];
  const profiles = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s+(.+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (match && /profil/i.test(match[1]) && match[2]) profiles.push(match[2]);
  }
  return profiles;
}

// "SSID <n> : <name>" is stable across locales; the following indented line
// with a percentage is that network's signal strength.
async function visibleNetworks(iface) {
  const args = ['wlan', 'show', 'networks', 'mode=bssid'];
  if (iface) args.push(`interface=${iface}`);
  const result = await run('netsh', args);
  if (!result.ok) return new Map();
  const networks = new Map(); // ssid -> best signal %
  let current = null;
  for (const line of result.stdout.split(/\r?\n/)) {
    const ssid = /^SSID\s+\d+\s*:\s*(.*?)\s*$/.exec(line.trim());
    if (ssid) {
      current = ssid[1];
      if (current && !networks.has(current)) networks.set(current, 0);
      continue;
    }
    const signal = current && /:\s*(\d{1,3})\s*%/.exec(line);
    if (signal) networks.set(current, Math.max(networks.get(current) ?? 0, Number(signal[1])));
  }
  networks.delete('');
  return networks;
}

export function createWifiAssist({ log, record }) {
  const supported = process.platform === 'win32';
  const state = {
    enabled: false,
    timer: null,
    busy: false,
    adapter: null,
    connected: false,
    lastAttempt: null, // { ssid, at }
    attemptIndex: 0,
    wasAssisting: false,
    detail: 'off',
    policy: null, // 'applied' | 'default' | null while unknown
    fixingPolicy: false,
  };
  if (supported) queryPolicy().then((policy) => { state.policy = policy; });

  async function check() {
    if (state.busy || !state.enabled) return;
    state.busy = true;
    try {
      const adapters = await wlanAdapters();
      if (!state.enabled) return; // disabled while we were probing
      if (!adapters.length) {
        state.adapter = null;
        state.connected = false;
        state.detail = 'no wireless adapter found';
        return;
      }
      const connected = adapters.find((adapter) => adapter.connected);
      if (connected) {
        state.adapter = connected.name;
        state.connected = true;
        state.detail = `${connected.name} is connected`;
        state.attemptIndex = 0;
        if (state.wasAssisting) {
          state.wasAssisting = false;
          record?.('up', `wifi assist: ${connected.name} reconnected`);
        }
        return;
      }

      const adapter = adapters[0];
      state.adapter = adapter.name;
      state.connected = false;
      if (state.lastAttempt && Date.now() - state.lastAttempt.at < CONNECT_COOLDOWN_MS) {
        state.detail = `waiting to retry (last tried "${state.lastAttempt.ssid}")`;
        return;
      }

      const profiles = await savedProfiles();
      if (!profiles.length) {
        state.detail = 'no saved Wi-Fi profiles to connect to';
        return;
      }
      const visible = await visibleNetworks(adapter.name);
      const inRange = profiles
        .filter((profile) => visible.has(profile))
        .sort((a, b) => (visible.get(b) ?? 0) - (visible.get(a) ?? 0));
      // A disconnected radio often reports a stale/empty scan list; falling
      // back to saved profiles lets a failed attempt still trigger a scan.
      const candidates = inRange.length ? inRange : profiles;
      const ssid = candidates[state.attemptIndex % candidates.length];
      state.attemptIndex += 1;
      state.lastAttempt = { ssid, at: Date.now() };
      state.wasAssisting = true;
      state.detail = `connecting ${adapter.name} to "${ssid}"…`;
      record?.('info', `wifi assist: connecting ${adapter.name} to "${ssid}"`);
      const result = await run('netsh', ['wlan', 'connect', `name=${ssid}`, `interface=${adapter.name}`]);
      if (!result.ok) {
        state.detail = `could not connect to "${ssid}" — will retry`;
        log.debug(`wifi assist: netsh connect failed for "${ssid}"`);
      }
    } finally {
      state.busy = false;
    }
  }

  return {
    status() {
      return {
        supported,
        enabled: state.enabled,
        adapter: state.adapter,
        connected: state.connected,
        detail: state.enabled ? state.detail : 'off',
        policy: state.policy,
        fixingPolicy: state.fixingPolicy,
      };
    },
    // Apply the "keep Wi-Fi with Ethernet" group policy via UAC. The
    // dashboard button drives this so no one has to hunt for the script.
    async fixPolicy() {
      if (!supported) return { ok: false, error: 'only available on Windows' };
      if (state.fixingPolicy) return { ok: false, error: 'a policy change is already waiting for Windows approval' };
      state.fixingPolicy = true;
      try {
        log.info('wifi: applying keep-Wi-Fi-with-Ethernet policy (answer the UAC prompt)');
        const result = await runPolicyScriptElevated();
        state.policy = await queryPolicy();
        if (!result.ok) return { ok: false, error: result.error, policy: state.policy };
        if (state.policy !== 'applied') {
          return { ok: false, error: 'Windows did not report the policy as applied', policy: state.policy };
        }
        record?.('info', 'Windows policy applied: Wi-Fi stays connected while Ethernet is up');
        return { ok: true, policy: state.policy };
      } finally {
        state.fixingPolicy = false;
      }
    },
    setEnabled(next) {
      if (!supported) return { ok: false, error: 'Wi-Fi assist is only available on Windows' };
      const wanted = Boolean(next);
      if (wanted === state.enabled) return { ok: true, enabled: state.enabled };
      state.enabled = wanted;
      if (wanted) {
        state.detail = 'checking…';
        state.attemptIndex = 0;
        record?.('info', 'wifi assist enabled — Wi-Fi will be kept connected alongside Ethernet');
        state.timer = setInterval(check, CHECK_MS);
        check();
      } else {
        clearInterval(state.timer);
        state.timer = null;
        state.detail = 'off';
        record?.('info', 'wifi assist disabled');
      }
      return { ok: true, enabled: state.enabled };
    },
    stop() {
      clearInterval(state.timer);
      state.timer = null;
      state.enabled = false;
    },
  };
}
