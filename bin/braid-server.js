#!/usr/bin/env node
// braid bonding server — runs on a VPS with a public IP. braid clients open
// one subflow per physical link to this server; it reassembles each app
// stream from frames arriving across all links and forwards to the target,
// giving a *single* connection the summed bandwidth of every link.
import process from 'node:process';
import { TunnelServer } from '../src/tunnel/server.js';

const VERSION = '3.1.3';

const HELP = `braid-server v${VERSION} — bonding relay for braid clients

Usage: node bin/braid-server.js [options]

Options:
  --port <n>        Port to listen on                       (default 7000)
  --bind <addr>     Address to listen on                    (default 0.0.0.0)
  --secret <token>  Shared secret clients must present       (default: none)
  --dial-from <ip>  Bind outbound connections to this local IP
  --quiet           Only log warnings and errors
  --help            Show this help

Point a client at it with:  braid --server <this-host>:<port> --secret <token>
`;

function parse(argv) {
  const args = { port: 7000, bind: '0.0.0.0', secret: '', dialFrom: undefined, quiet: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[++i] ?? die(`missing value for ${arg}`);
    switch (arg) {
      case '--port': args.port = Number(value()); break;
      case '--bind': args.bind = value(); break;
      case '--secret': args.secret = value(); break;
      case '--dial-from': args.dialFrom = value(); break;
      case '--quiet': args.quiet = true; break;
      case '--help': case '-h': console.log(HELP); process.exit(0); break;
      default: die(`unknown option "${arg}"`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) die('--port must be 1-65535');
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
  console.log(`  auth:      ${args.secret ? 'secret required' : 'OPEN (no secret — anyone can relay through this server)'}`);
  if (args.dialFrom) console.log(`  dial-from: ${args.dialFrom}`);
  console.log('');
  if (!args.secret) log.warn('running without --secret: this is an open relay. Set a secret in production.');
});

setInterval(() => {
  const s = server.stats();
  if (s.subflows || s.streams) log.info(`status: ${s.tunnels} tunnel(s), ${s.subflows} subflow(s), ${s.streams} stream(s)`);
}, 30000);

process.on('SIGINT', () => { console.log('\nbraid-server stopped.'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
