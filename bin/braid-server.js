#!/usr/bin/env node
// braid bonding server — runs on a VPS with a public IP. braid clients open
// one subflow per physical link to this server; it reassembles each app
// stream from frames arriving across all links and forwards to the target,
// giving a *single* connection the summed bandwidth of every link.
import process from 'node:process';
import { TunnelServer } from '../src/tunnel/server.js';

const VERSION = '3.0.0';

const HELP = `braid-server v${VERSION} — bonding relay for braid clients

Usage: node bin/braid-server.js [options]

Options:
  --port <n>        Port to listen on                       (default 7000)
  --bind <addr>     Address to listen on                    (default 0.0.0.0)
  --secret <token>  Shared secret clients must present
                    Can also be set with BRAID_SECRET.
  --allow-open-relay
                    Start without auth; only for isolated test networks.
  --dial-from <ip>  Bind outbound connections to this local IP
  --quiet           Only log warnings and errors
  --help            Show this help

Point a client at it with:  braid --server <this-host>:<port> --secret <token>
`;

function parse(argv) {
  const args = {
    port: 7000,
    bind: '0.0.0.0',
    secret: process.env.BRAID_SECRET ?? '',
    allowOpenRelay: false,
    dialFrom: undefined,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith('--') && arg.includes('=')) {
      const eq = arg.indexOf('=');
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = () => inline ?? argv[++i] ?? die(`missing value for ${arg}`);
    switch (arg) {
      case '--port': args.port = Number(value()); break;
      case '--bind': args.bind = value(); break;
      case '--secret': args.secret = value(); break;
      case '--allow-open-relay': args.allowOpenRelay = true; break;
      case '--dial-from': args.dialFrom = value(); break;
      case '--quiet': args.quiet = true; break;
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      default: die(`unknown option "${arg}"`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) die('--port must be 1-65535');
  if (Buffer.byteLength(args.secret, 'utf8') > 255) die('--secret must be 255 bytes or less');
  if (!args.secret && !args.allowOpenRelay) {
    die('refusing to run as an open relay; pass --secret <token> or set BRAID_SECRET, or use --allow-open-relay for an isolated test network');
  }
  return args;
}

function die(message) {
  console.error(`braid-server: ${message}`);
  process.exit(1);
}

const args = parse(process.argv);
const ts = () => new Date().toISOString().slice(11, 19);
const log = {
  info: args.quiet ? () => {} : (m) => console.log(`${ts()} ${m}`),
  warn: (m) => console.log(`${ts()} WARN ${m}`),
  error: (m) => console.error(`${ts()} ERROR ${m}`),
  debug: () => {},
};

const server = new TunnelServer({ secret: args.secret, dialFrom: args.dialFrom, log });
server.listen(args.port, args.bind, () => {
  console.log(`\nbraid-server v${VERSION} listening on ${args.bind}:${args.port}`);
  console.log(`  auth:      ${args.secret ? 'secret required' : 'OPEN (explicit --allow-open-relay)'}`);
  if (args.dialFrom) console.log(`  dial-from: ${args.dialFrom}`);
  console.log('');
  if (!args.secret) log.warn('running without --secret: anyone who can connect can relay through this server.');
});

setInterval(() => {
  const s = server.stats();
  if (s.subflows || s.streams) log.info(`status: ${s.tunnels} tunnel(s), ${s.subflows} subflow(s), ${s.streams} stream(s)`);
}, 30000);

process.on('SIGINT', () => { console.log('\nbraid-server stopped.'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
