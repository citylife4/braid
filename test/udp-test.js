// Smoke test for braid's SOCKS5 UDP ASSOCIATE: performs the handshake, then
// resolves a name by sending a real DNS query to 8.8.8.8 through the relay.
//   node test/udp-test.js [proxyPort] [name]
import net from 'node:net';
import dgram from 'node:dgram';
import process from 'node:process';

const PORT = Number(process.argv[2] ?? 1080);
const NAME = process.argv[3] ?? 'example.com';

const die = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
setTimeout(() => die('timed out after 10s'), 10000).unref();

function dnsQuery(name) {
  const labels = name.split('.').flatMap((l) => [l.length, ...Buffer.from(l)]);
  return Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, 1, 0, 1]);
}

function firstARecord(reply) {
  if (reply.length < 12) return null;
  const answers = reply.readUInt16BE(6);
  if (!answers) return null;
  let at = 12;
  while (reply[at] !== 0) at += reply[at] + 1; // skip question name
  at += 5;
  for (let i = 0; i < answers; i += 1) {
    if ((reply[at] & 0xc0) === 0xc0) at += 2;
    else { while (reply[at] !== 0) at += reply[at] + 1; at += 1; }
    const type = reply.readUInt16BE(at);
    const rdlen = reply.readUInt16BE(at + 8);
    at += 10;
    if (type === 1 && rdlen === 4) return [...reply.subarray(at, at + 4)].join('.');
    at += rdlen;
  }
  return null;
}

const control = net.connect({ host: '127.0.0.1', port: PORT }, () => {
  control.write(Buffer.from([5, 1, 0]));
});
control.on('error', (err) => die(`control connection: ${err.message}`));

let stage = 0;
control.on('data', (buf) => {
  if (stage === 0) {
    if (buf[0] !== 5 || buf[1] !== 0) die(`method negotiation rejected: ${buf.inspect()}`);
    stage = 1;
    control.write(Buffer.from([5, 3, 0, 1, 0, 0, 0, 0, 0, 0])); // UDP ASSOCIATE
    return;
  }
  if (stage === 1) {
    if (buf[1] !== 0) die(`associate refused, code ${buf[1]}`);
    const relayIp = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
    const relayPort = buf.readUInt16BE(8);
    console.log(`associate OK — relay at ${relayIp}:${relayPort}`);
    stage = 2;

    const udp = dgram.createSocket('udp4');
    const query = dnsQuery(NAME);
    const packet = Buffer.concat([Buffer.from([0, 0, 0, 1, 8, 8, 8, 8, 0, 53]), query]);
    udp.on('message', (msg) => {
      const answer = firstARecord(msg.subarray(10));
      if (!answer) die('DNS reply had no A record');
      console.log(`PASS: ${NAME} -> ${answer} (resolved via braid UDP relay)`);
      udp.close();
      control.destroy();
      process.exit(0);
    });
    udp.send(packet, relayPort, relayIp);
  }
});
