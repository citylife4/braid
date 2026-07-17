import dgram from 'node:dgram';
import net from 'node:net';

const IDLE_TIMEOUT = 300000; // associations die after 5 minutes of silence

// SOCKS5 UDP ASSOCIATE relay. Each association is pinned to one link for its
// lifetime, so a UDP session (a game, a call, a DNS exchange) stays on one
// path while different sessions spread across links.
//
// Returns { port, teardown }; rejects if the relay could not be set up.
export function startUdpAssociation({ control, clientIp, bindAddress, link, manager, log }) {
  return new Promise((resolve, reject) => {
    const relay = dgram.createSocket('udp4'); // faces the SOCKS client
    const outbound = dgram.createSocket('udp4'); // faces the internet, bound to the link
    let clientPort = null;
    let ready = false;
    let closed = false;
    let idleTimer = null;

    const teardown = (reason) => {
      if (closed) return;
      closed = true;
      clearTimeout(idleTimer);
      try { relay.close(); } catch { /* already closed */ }
      try { outbound.close(); } catch { /* already closed */ }
      manager.untrackUdp(link);
      control.destroy();
      if (!ready) reject(reason instanceof Error ? reason : new Error(String(reason ?? 'udp setup failed')));
      log.debug(`udp   association via ${link.name} closed`);
    };
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => teardown('idle'), IDLE_TIMEOUT);
    };

    relay.on('error', teardown);
    outbound.on('error', teardown);
    control.on('close', () => teardown('control connection closed'));

    relay.on('message', (msg, rinfo) => {
      if (rinfo.address !== clientIp) return; // only our client may use the relay
      if (clientPort === null) clientPort = rinfo.port;
      else if (rinfo.port !== clientPort) return;
      bump();
      const packet = parseUdpPacket(msg);
      if (!packet) return;
      const { host, port, data, isDomain } = packet;
      if (!isDomain) {
        send(host, port, data);
        return;
      }
      // manager.resolveHost caches, so repeated datagrams to one name are cheap.
      manager.resolveHost(host)
        .then((address) => send(address, port, data))
        .catch(() => log.debug(`udp   dropped datagram for unresolvable ${host}`));
    });

    function send(address, port, data) {
      if (closed) return;
      link.bytesOut += data.length;
      outbound.send(data, port, address);
    }

    outbound.on('message', (msg, rinfo) => {
      if (closed || clientPort === null) return;
      bump();
      link.bytesIn += msg.length;
      relay.send(wrapUdpPacket(rinfo.address, rinfo.port, msg), clientPort, clientIp);
    });

    relay.bind({ address: bindAddress, port: 0, exclusive: true }, () => {
      outbound.bind({ address: link.address, port: 0, exclusive: true }, () => {
        ready = true;
        manager.trackUdp(link);
        bump();
        resolve({ port: relay.address().port, teardown });
      });
    });
  });
}

// Datagram from client: RSV(2) FRAG(1) ATYP(1) ADDR PORT(2) DATA
function parseUdpPacket(msg) {
  if (msg.length < 10 || msg[2] !== 0x00) return null; // fragmentation unsupported
  const atyp = msg[3];
  if (atyp === 0x01) {
    const host = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
    return { host, port: msg.readUInt16BE(8), data: msg.subarray(10), isDomain: false };
  }
  if (atyp === 0x03) {
    const length = msg[4];
    if (msg.length < 5 + length + 2) return null;
    const name = msg.subarray(5, 5 + length).toString('utf8');
    const port = msg.readUInt16BE(5 + length);
    const data = msg.subarray(5 + length + 2);
    // Some clients put dotted IPs in the domain field.
    return { host: name, port, data, isDomain: net.isIP(name) === 0 };
  }
  return null; // IPv6 targets unsupported
}

function wrapUdpPacket(address, port, data) {
  const header = Buffer.alloc(10);
  header[3] = 0x01;
  const parts = address.split('.').map(Number);
  if (parts.length === 4) header.set(parts, 4);
  header.writeUInt16BE(port, 8);
  return Buffer.concat([header, data]);
}
