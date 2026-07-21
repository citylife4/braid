// Failover correctness test for the bonding tunnel: while a large payload is
// streaming across several subflows, one subflow is repeatedly killed
// (simulating a USB Wi-Fi adapter reset or powerline dropout). The transfer
// must still complete, in order and bit-perfect, because the dead subflow's
// in-flight frames are retransmitted over the survivors.
//
//   node test/tunnel-failover-test.js [numLinks] [payloadMB]
import net from 'node:net';
import crypto from 'node:crypto';
import process from 'node:process';
import { TunnelServer } from '../src/tunnel/server.js';
import { TunnelClient } from '../src/tunnel/client.js';

const NUM_LINKS = Math.max(2, Number(process.argv[2] ?? 3));
const SIZE = Math.round(Number(process.argv[3] ?? 48) * 1024 * 1024);
const SECRET = 'test-secret';

const silent = { info() {}, warn() {}, error(m) { console.error(m); }, debug() {} };
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };
setTimeout(() => die('timed out'), 60000).unref();

const seed = crypto.randomBytes(SIZE);
const expected = crypto.createHash('sha256').update(seed).digest('hex');
const target = net.createServer((s) => {
  s.on('data', () => {});
  s.end(seed);
});

const fakeManager = {
  links: [],
  healthy() { return this.links; },
  on() {},
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

    // Chaos: keep hard-killing subflows mid-transfer — but never the last
    // survivor, mirroring the real failure mode (one flaky link at a time,
    // e.g. a USB Wi-Fi adapter resetting). The client's reconnect timer
    // brings each victim back, so links come and go throughout the download.
    let kills = 0;
    let next = 0;
    const chaos = setInterval(() => {
      const victim = client.subflows.get(`link${next % NUM_LINKS}`);
      next += 1;
      if (victim?.ready && client.readyCount() > 1) {
        kills += 1;
        victim.socket.destroy();
      }
    }, 120);

    client.open('127.0.0.1', targetPort).then(({ socket }) => {
      const hash = crypto.createHash('sha256');
      let received = 0;
      socket.on('data', (chunk) => { received += chunk.length; hash.update(chunk); });
      socket.on('end', () => {
        clearInterval(chaos);
        const got = hash.digest('hex');
        if (received !== SIZE) die(`size mismatch: got ${received}, expected ${SIZE}`);
        if (got !== expected) die('checksum mismatch — data corrupted across failovers');
        if (!kills) die('no subflow was ever killed — the test proved nothing');
        console.log(`PASS: ${(SIZE / 1048576).toFixed(0)}MB intact across ${NUM_LINKS} subflows despite ${kills} mid-transfer subflow kills`);
        process.exit(0);
      });
      socket.end();
    }).catch((err) => die(`open failed: ${err.message}`));
  });
});
