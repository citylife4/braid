// End-to-end correctness test for the bonding tunnel, entirely in-process:
// an echo target, a braid-server, a LinkManager with N loopback "links", a
// TunnelClient, and a check that a large random payload survives a round trip
// through the multipath tunnel intact (order + integrity + FIN).
//
//   node test/tunnel-test.js [numLinks] [payloadMB]
import net from 'node:net';
import crypto from 'node:crypto';
import process from 'node:process';
import { TunnelServer } from '../src/tunnel/server.js';
import { TunnelClient } from '../src/tunnel/client.js';

const NUM_LINKS = Number(process.argv[2] ?? 3);
const SIZE = Math.round(Number(process.argv[3] ?? 8) * 1024 * 1024);
const SECRET = 'test-secret';

const silent = { info() {}, warn() {}, error(m) { console.error(m); }, debug() {} };
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => die('timed out'), 30000).unref();

// A target server that streams back SIZE bytes of deterministic data, so the
// client can verify integrity by hashing.
const seed = crypto.randomBytes(SIZE);
const expected = crypto.createHash('sha256').update(seed).digest('hex');
const target = net.createServer((s) => {
  s.on('data', () => {});
  s.end(seed);
});

// Several "links" that are really just loopback — enough to exercise spraying
// frames across multiple subflows and reassembling them.
const fakeManager = {
  links: [],
  healthy() { return this.links; },
  on() {}, // no hot-plug in the test
};
for (let i = 0; i < NUM_LINKS; i += 1) {
  fakeManager.links.push({ name: `link${i}`, address: '127.0.0.1', weight: 1, bytesIn: 0, bytesOut: 0, up: true, enabled: true });
}

target.listen(0, '127.0.0.1', () => {
  const targetPort = target.address().port;
  const server = new TunnelServer({ secret: SECRET, dialFrom: '127.0.0.1', log: silent });
  server.listen(0, '127.0.0.1', () => {
    const serverPort = server.server.address().port;
    const client = new TunnelClient(fakeManager, { host: '127.0.0.1', port: serverPort, secret: SECRET, log: silent });
    client.start();

    client.open('127.0.0.1', targetPort).then(({ socket }) => {
      const hash = crypto.createHash('sha256');
      let received = 0;
      socket.on('data', (chunk) => { received += chunk.length; hash.update(chunk); });
      socket.on('end', () => {
        const got = hash.digest('hex');
        if (received !== SIZE) die(`size mismatch: got ${received}, expected ${SIZE}`);
        if (got !== expected) die('checksum mismatch — data corrupted across subflows');
        const perLink = fakeManager.links.map((l) => `${l.name}:${(l.bytesIn / 1048576).toFixed(1)}MB`).join(' ');
        console.log(`PASS: ${(SIZE / 1048576).toFixed(0)}MB intact across ${NUM_LINKS} subflows (${got.slice(0, 12)}…)`);
        console.log(`      per-subflow bytes in: ${perLink}`);
        process.exit(0);
      });
      socket.end(); // half-close our side; target streams its payload back
    }).catch((err) => die(`open failed: ${err.message}`));
  });
});
