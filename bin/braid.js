#!/usr/bin/env node
import net from 'node:net';
import process from 'node:process';
import { readFileSync } from 'node:fs';
import { discoverInterfaces, LinkManager, STRATEGIES } from '../src/links.js';
import { createPicker } from '../src/dispatch.js';
import { createProxyServer } from '../src/proxy.js';
import { createDashboard } from '../src/dashboard.js';
import { createCapture } from '../src/capture.js';
import { createAutostart } from '../src/autostart.js';
import { createWifiAssist } from '../src/wifi.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { TunnelClient } from '../src/tunnel/client.js';
import { openBrowser } from '../src/open-browser.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `braid v${VERSION} — bond multiple internet connections into one reliable connection

Usage: node bin/braid.js [options]        (or braid-gui.vbs for the GUI, no console)

Options:
  --port <n>            Proxy port for SOCKS5/SOCKS4/HTTP clients    (default 1080)
  --bind <addr>         Address to listen on                         (default 127.0.0.1)
  --dashboard <n>       GUI/dashboard port, 0 to disable             (default 8181)
  --links <spec>        Comma-separated links to bond, by interface
                        name or IPv4 address, optional =weight,
                        e.g. --links "Ethernet=3,Wi-Fi=1"            (default: all)
  --strategy <name>     adaptive | balanced | least-busy | failover  (default adaptive)
  --server <host:port>  Bond through a braid-server for TRUE single-stream
                        aggregation (summed bandwidth on one connection)
  --secret <token>      Shared secret for --server
  --open                Open the control panel in a browser once ready
  --wifi-assist         Keep Wi-Fi connected even while Ethernet is up
                        (also a toggle in the GUI)
  --check-interval <s>  Seconds between link health checks           (default 5)
  --check-timeout <s>   Health check timeout in seconds              (default 3)
  --verbose             Log every proxied connection
  --list                Show detected interfaces and exit
  --help                Show this help

Without --server, aggregation is per-connection (many connections spread over
links). With --server pointed at a braid-server on a VPS, a single connection's
bytes are split across every link and reassembled — Speedify-style bonding.

System-wide capture (all Windows apps, no proxy settings needed) is toggled
from the GUI, or manually: engine\\enable-capture.ps1 (needs admin/UAC).
`;

const useColor = process.stdout.isTTY;
const paint = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const cyan = paint(36);
const dim = paint(2);
const bold = paint(1);

function fail(message) {
  console.error(red(`braid: ${message}`));
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    port: 1080,
    bind: '127.0.0.1',
    dashboard: 8181,
    links: null,
    strategy: 'adaptive',
    server: null,
    secret: '',
    open: false,
    wifiAssist: false,
    checkInterval: 5,
    checkTimeout: 3,
    verbose: false,
    list: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = () => inline ?? argv[++i] ?? fail(`missing value for ${arg}`);
    switch (arg) {
      case '--port': args.port = Number(value()); break;
      case '--bind': args.bind = value(); break;
      case '--dashboard': args.dashboard = Number(value()); break;
      case '--links': args.links = value(); break;
      case '--strategy': args.strategy = value(); break;
      case '--server': args.server = value(); break;
      case '--secret': args.secret = value(); break;
      case '--open': args.open = true; break;
      case '--wifi-assist': args.wifiAssist = true; break;
      case '--check-interval': args.checkInterval = Number(value()); break;
      case '--check-timeout': args.checkTimeout = Number(value()); break;
      case '--verbose': args.verbose = true; break;
      case '--list': args.list = true; break;
      case '--help':
      case '-h':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        fail(`unknown option "${arg}" (try --help)`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) fail('--port must be 1-65535');
  if (!Number.isInteger(args.dashboard) || args.dashboard < 0 || args.dashboard > 65535) fail('--dashboard must be 0-65535');
  if (!STRATEGIES.includes(args.strategy)) fail(`--strategy must be one of: ${STRATEGIES.join(', ')}`);
  if (!(args.checkInterval > 0) || !(args.checkTimeout > 0)) fail('check interval/timeout must be positive');
  if (args.server) {
    const parsed = parseServer(args.server);
    if (!parsed) fail('--server must be host:port, e.g. --server vps.example.com:7000');
    args.server = parsed;
  }
  return args;
}

function parseServer(value) {
  const at = value.lastIndexOf(':');
  if (at === -1) return null;
  const host = value.slice(0, at);
  const port = Number(value.slice(at + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function resolveLinks(spec) {
  const available = discoverInterfaces();
  if (!spec) {
    if (!available.length) fail('no usable IPv4 interfaces found');
    return available.map((iface) => ({ name: iface.name, address: iface.address, weight: 1, pinned: false }));
  }
  return spec.split(',').map((raw) => {
    const [id, weightRaw] = raw.trim().split('=');
    const weight = weightRaw === undefined ? 1 : Number(weightRaw);
    if (!Number.isFinite(weight) || weight <= 0) fail(`invalid weight in "${raw.trim()}"`);
    if (net.isIPv4(id)) {
      const match = available.find((iface) => iface.address === id);
      return { name: match ? match.name : id, address: id, weight, pinned: true };
    }
    const match = available.find((iface) => iface.name.toLowerCase() === id.toLowerCase());
    if (!match) {
      fail(`interface "${id}" not found — available: ${available.map((i) => `${i.name} (${i.address})`).join(', ')}`);
    }
    return { name: match.name, address: match.address, weight, pinned: false };
  });
}

const args = parseArgs(process.argv);

if (args.list) {
  const found = discoverInterfaces();
  if (!found.length) {
    console.log('No usable IPv4 interfaces found.');
    process.exit(0);
  }
  console.log(bold('\nDetected interfaces:\n'));
  for (const iface of found) {
    console.log(`  ${iface.name.padEnd(28)} ${iface.address.padEnd(16)} ${dim(iface.mac)}`);
  }
  console.log(dim(`\nBond them with:  node bin/braid.js --links "${found.map((i) => i.name).join(',')}"\n`));
  process.exit(0);
}

const defs = resolveLinks(args.links);
const manager = new LinkManager(defs, {
  checkInterval: args.checkInterval * 1000,
  checkTimeout: args.checkTimeout * 1000,
  strategy: args.strategy,
  autoDiscover: !args.links, // explicit --links means: bond exactly these
});
const pick = createPicker(manager);

const log = {
  info: (m) => console.log(m),
  warn: (m) => console.log(yellow(m)),
  error: (m) => console.error(red(m)),
  debug: args.verbose ? (m) => console.log(dim(m)) : () => {},
};

manager.on('up', (link) => log.info(`${green('●')} ${link.name} (${link.address}) is ${green('back up')}`));
manager.on('down', (link) => log.info(`${red('●')} ${link.name} (${link.address}) is ${red('DOWN')} — traffic shifted to remaining links`));
manager.on('added', (link) => log.info(`${green('●')} ${link.name} (${link.address}) ${green('connected')} — added to the bond`));

const capture = createCapture({ proxyPort: args.port, dashboardPort: args.dashboard, log });
const autostart = createAutostart({ log });
const settings = loadSettings(log);

const wifiAssist = createWifiAssist({ log, record: (kind, message) => manager.record(kind, message) });
// GUI toggles persist; the CLI flag applies to this run without being saved.
const wifi = {
  status: () => wifiAssist.status(),
  fixPolicy: () => wifiAssist.fixPolicy(),
  setEnabled: (enabled) => {
    const result = wifiAssist.setEnabled(enabled);
    if (result.ok) saveSettings({ wifiAssist: Boolean(enabled) }, log);
    return result;
  },
};
if (args.wifiAssist || settings.wifiAssist) wifiAssist.setEnabled(true);

// The bonding server is runtime-configurable from the GUI: the proxy reads
// runtime.tunnel on every new connection, so swapping the client (or removing
// it) applies immediately without a restart.
const runtime = { manager, pick, log, bindAddress: args.bind, tunnel: null };

function setTunnel(config) {
  if (runtime.tunnel) {
    runtime.tunnel.stop();
    runtime.tunnel = null;
  }
  if (config) {
    runtime.tunnel = new TunnelClient(manager, { host: config.host, port: config.port, secret: config.secret ?? '', log });
    runtime.tunnel.start();
  }
}

function savedTunnelSummary() {
  const saved = loadSettings(log).tunnel;
  return saved?.host ? { host: saved.host, port: saved.port, hasSecret: Boolean(saved.secret) } : null;
}

const tunnelControl = {
  status: () => (runtime.tunnel
    ? { ...runtime.tunnel.status(), saved: savedTunnelSummary() }
    : { enabled: false, saved: savedTunnelSummary() }),
  configure: ({ host, port, secret }) => {
    const cleanHost = typeof host === 'string' ? host.trim() : '';
    const cleanPort = Number(port);
    // No secret in the request = keep the saved one (the GUI never echoes it).
    const cleanSecret = secret == null ? (loadSettings(log).tunnel?.secret ?? '') : String(secret);
    if (!cleanHost || cleanHost.length > 253 || /[\s/]/.test(cleanHost)) {
      return { ok: false, error: 'enter the braid-server host name or IP' };
    }
    if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) {
      return { ok: false, error: 'server port must be 1-65535' };
    }
    if (cleanSecret.length > 256) return { ok: false, error: 'secret is too long (max 256 characters)' };
    setTunnel({ host: cleanHost, port: cleanPort, secret: cleanSecret });
    saveSettings({ tunnel: { host: cleanHost, port: cleanPort, secret: cleanSecret } }, log);
    manager.record('info', `true bonding enabled via ${cleanHost}:${cleanPort}`);
    log.info(`tunnel: bonding via ${cleanHost}:${cleanPort}`);
    return { ok: true, server: `${cleanHost}:${cleanPort}` };
  },
  disable: () => {
    if (runtime.tunnel) {
      setTunnel(null);
      manager.record('info', 'true bonding disabled — connections ride single links again');
    }
    saveSettings({ tunnel: null }, log);
    return { ok: true, enabled: false };
  },
};

// CLI flags win for this run; otherwise the GUI-saved server reconnects.
const initialTunnel = args.server
  ? { host: args.server.host, port: args.server.port, secret: args.secret }
  : (settings.tunnel?.host ? settings.tunnel : null);

const dashboardUrl = `http://127.0.0.1:${args.dashboard}`;

const proxy = createProxyServer(runtime);
proxy.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Already running: if we were asked to open the GUI, just surface the
    // existing instance instead of failing.
    if (args.open && args.dashboard) {
      openBrowser(dashboardUrl);
      process.exit(0);
    }
    fail(`port ${args.port} is already in use`);
  }
  fail(err.message);
});
proxy.listen(args.port, args.bind, () => {
  console.log(bold(`\nbraid v${VERSION} — bonding ${defs.length} link${defs.length === 1 ? '' : 's'} (${manager.strategy})\n`));
  for (const link of manager.links) {
    console.log(`  ${green('●')} ${link.name.padEnd(28)} ${link.address.padEnd(16)} ${dim(`weight ${link.weight}`)}`);
  }
  console.log(`\n  Proxy      ${cyan(`${args.bind}:${args.port}`)}  ${dim('(SOCKS5 + UDP, SOCKS4/4a and HTTP on one port)')}`);
  if (runtime.tunnel) console.log(`  Bonding    ${cyan(`${runtime.tunnel.host}:${runtime.tunnel.port}`)}  ${dim('(true single-stream aggregation via braid-server)')}`);
  if (args.dashboard) console.log(`  GUI        ${cyan(dashboardUrl)}  ${dim('(or run braid-gui.vbs)')}`);
  console.log(dim('\n  System-wide capture for all apps: use the GUI toggle (needs admin).'));
  console.log(dim('  Ctrl+C to stop.\n'));
  if (args.bind !== '127.0.0.1' && args.bind !== 'localhost') {
    log.warn('  warning: the proxy is exposed beyond localhost with no authentication —');
    log.warn('  anyone who can reach it can tunnel traffic through this machine.\n');
  }
  if (args.open && args.dashboard) openBrowser(dashboardUrl);
});

manager.record('info', `braid started with ${defs.length} link(s), strategy "${args.strategy}"${initialTunnel ? `, bonding via ${initialTunnel.host}:${initialTunnel.port}` : ''}`);
manager.start();
if (initialTunnel) setTunnel(initialTunnel);

function shutdown() {
  console.log('\nbraid stopped.');
  process.exit(0);
}

if (args.dashboard) {
  const dashboard = createDashboard({
    manager,
    capture,
    autostart,
    wifi,
    tunnelControl,
    onQuit: shutdown,
    meta: () => ({
      version: VERSION,
      strategies: STRATEGIES,
      proxy: `${args.bind}:${args.port}`,
      proxyPort: args.port,
      tunnel: tunnelControl.status(),
    }),
  });
  dashboard.on('error', (err) => log.error(`dashboard: ${err.message}`));
  dashboard.listen(args.dashboard, '127.0.0.1');
}

process.on('SIGINT', shutdown);
