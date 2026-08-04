// Abnormal-close correctness test for the bonding tunnel:
//
//  1. A stream is destroyed client-side mid-download (the app aborted, e.g. a
//     cancelled download). The server must learn about it (RESET), close its
//     target connection, and both ends must drop the stream's engine instead
//     of retransmitting into the void forever.
//  2. An OPEN that the server cannot even dial (port 0 is invalid for
//     net.connect) must come back as a fast OPEN_ERR and must NOT kill the
//     subflow that carried it.
//
//   node test/tunnel-abort-test.js
import net from 'node:net';
import crypto from 'node:crypto';
import process from 'node:process';
import { TunnelServer } from '../src/tunnel/server.js';
import { TunnelClient } from '../src/tunnel/client.js';

const SECRET = 'test-secret';
const silent = { info() {}, warn() {}, error(m) { console.error(m); }, debug() {} };
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => die('timed out'), 30000).unref();

// A target that streams data forever and never ends on its own; the only way
// it stops is the tunnel server closing the connection.
let targetSockets = 0;
const target = net.createServer((s) => {
  targetSockets += 1;
  const feed = setInterval(() => {
    if (!s.destroyed) s.write(crypto.randomBytes(16384));
  }, 15);
  s.on('close', () => {
    targetSockets -= 1;
    clearInterval(feed);
  });
  s.on('error', () => {});
});

const fakeManager = {
  links: [
    { name: 'link0', address: '127.0.0.1', weight: 1, bytesIn: 0, bytesOut: 0, up: true, enabled: true },
    { name: 'link1', address: '127.0.0.1', weight: 1, bytesIn: 0, bytesOut: 0, up: true, enabled: true },
  ],
  healthy() { return this.links; },
  on() {},
};

async function main(targetPort, server, client) {
  // --- scenario 1: mid-download abort ---
  const { socket } = await client.open('127.0.0.1', targetPort);
  await new Promise((resolve) => {
    let received = 0;
    socket.on('data', (chunk) => {
      received += chunk.length;
      if (received > 256 * 1024) resolve();
    });
  });
  socket.destroy(); // the app aborted: no clean end, no error

  // The orphaned engine must reset itself as soon as arriving data has
  // nowhere to go, and the server must drop the stream + target socket.
  const deadline = Date.now() + 8000;
  for (;;) {
    const serverTunnel = [...server.tunnels.values()][0];
    const serverStreams = serverTunnel ? serverTunnel.streams.size : 0;
    const engine = [...client.engines.values()][0];
    if (serverStreams === 0 && targetSockets === 0 && (!engine || engine.closed)) break;
    if (Date.now() > deadline) {
      die(`abort leak: serverStreams=${serverStreams} targetSockets=${targetSockets} clientEngineClosed=${engine?.closed}`);
    }
    await delay(200);
  }
  console.log('PASS: aborted stream was reset on both ends (no leaked engines or target sockets)');

  // --- scenario 2: undialable OPEN must not kill the subflow ---
  const before = client.readyCount();
  const started = Date.now();
  try {
    await client.open('127.0.0.1', 0);
    die('open to port 0 unexpectedly succeeded');
  } catch (err) {
    if (Date.now() - started > 5000) die(`open to port 0 rejected too slowly (${Date.now() - started} ms — subflow died?)`);
    console.log(`PASS: undialable target rejected fast (${err.code ?? err.message})`);
  }
  await delay(500);
  if (client.readyCount() < before) die(`a bad OPEN killed a subflow (${client.readyCount()}/${before} ready)`);
  console.log('PASS: subflows survived the bad OPEN');
  process.exit(0);
}

target.listen(0, '127.0.0.1', () => {
  const targetPort = target.address().port;
  const server = new TunnelServer({ secret: SECRET, dialFrom: '127.0.0.1', log: silent });
  server.listen(0, '127.0.0.1', () => {
    const client = new TunnelClient(fakeManager, { host: '127.0.0.1', port: server.server.address().port, secret: SECRET, log: silent });
    client.start();
    main(targetPort, server, client).catch((err) => die(err.stack ?? err.message));
  });
});
