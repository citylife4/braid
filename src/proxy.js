import net from 'node:net';
import { createReader } from './reader.js';
import { dial } from './dispatch.js';
import { startUdpAssociation } from './udp.js';

// One listener speaks all three protocols, sniffed from the first byte:
// 0x05 = SOCKS5, 0x04 = SOCKS4/4a, anything else = HTTP proxy.
export function createProxyServer(options) {
  return net.createServer((client) => {
    client.setNoDelay(true);
    client.on('error', () => {});
    handle(client, options).catch((err) => {
      options.log.debug(`handshake failed: ${err.message}`);
      client.destroy();
    });
  });
}

async function handle(client, options) {
  const reader = createReader(client);
  const first = await reader.peek(1);
  if (first[0] === 0x05) return socks5(client, reader, options);
  if (first[0] === 0x04) return socks4(client, reader, options);
  return httpProxy(client, reader, options);
}

async function socks5(client, reader, options) {
  const [, methodCount] = await reader.take(2);
  const methods = await reader.take(methodCount);
  if (!methods.includes(0x00)) {
    client.end(Buffer.from([0x05, 0xff])); // we only support "no authentication"
    return;
  }
  client.write(Buffer.from([0x05, 0x00]));

  const [, command, , addressType] = await reader.take(4);
  let host = null;
  if (addressType === 0x01) {
    host = [...(await reader.take(4))].join('.');
  } else if (addressType === 0x03) {
    const length = (await reader.take(1))[0];
    host = (await reader.take(length)).toString('utf8');
  } else if (addressType === 0x04) {
    await reader.take(16); // IPv6 target: read it fully, then refuse below
  }
  const port = (await reader.take(2)).readUInt16BE(0);

  const refuse = (code) => client.end(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));

  if (command === 0x03) return udpAssociate(client, reader, options, refuse);
  if (command !== 0x01) return refuse(0x07); // CONNECT and UDP ASSOCIATE only
  if (!host) return refuse(0x08);

  try {
    const { socket: remote, link, tracked } = await dialOut(options, host, port);
    const bound = boundAddress(remote);
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, ...bound.ip, ...bound.port]));
    splice(client, reader, remote, link, `${host}:${port}`, options, { tracked });
  } catch (err) {
    refuse(socks5ErrorCode(err));
  }
}

// UDP ASSOCIATE: set up a datagram relay pinned to one link. The TCP
// connection stays open purely as the association's lifetime handle.
async function udpAssociate(client, reader, options, refuse) {
  const { manager, pick, log } = options;
  try {
    const link = pick(new Set());
    if (!link) throw Object.assign(new Error('no links available'), { code: 'ENOLINK' });
    const clientIp = normalizeIp(client.remoteAddress);
    const { port } = await startUdpAssociation({
      control: client,
      clientIp,
      bindAddress: options.bindAddress,
      link,
      manager,
      log,
    });
    manager.track(link, client);
    reader.drain();
    reader.detach();
    const bnd = ipBytes(client.localAddress);
    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, ...bnd, (port >> 8) & 0xff, port & 0xff]));
    log.debug(`udp   association for ${clientIp} via ${link.name} (relay :${port})`);
  } catch (err) {
    log.debug(`udp   associate failed: ${err.message}`);
    refuse(socks5ErrorCode(err));
  }
}

async function socks4(client, reader, options) {
  const head = await reader.take(8);
  const command = head[1];
  const port = head.readUInt16BE(2);
  const ip = head.subarray(4, 8);
  await reader.takeUntil('\0'); // user id, ignored

  let host;
  if (ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0) {
    const domain = await reader.takeUntil('\0'); // SOCKS4a: domain follows
    host = domain.subarray(0, domain.length - 1).toString('utf8');
  } else {
    host = [...ip].join('.');
  }

  const refuse = () => client.end(Buffer.from([0x00, 0x5b, ...head.subarray(2, 8)]));
  if (command !== 0x01) return refuse();

  try {
    const { socket: remote, link, tracked } = await dialOut(options, host, port);
    client.write(Buffer.from([0x00, 0x5a, ...head.subarray(2, 8)]));
    splice(client, reader, remote, link, `${host}:${port}`, options, { tracked });
  } catch {
    refuse();
  }
}

const HOP_HEADERS = /^(proxy-connection|proxy-authorization|connection|keep-alive)\s*:/i;

async function httpProxy(client, reader, options) {
  const raw = (await reader.takeUntil('\r\n\r\n')).toString('latin1');
  const lines = raw.split('\r\n');
  const [method, target, version = 'HTTP/1.1'] = (lines[0] ?? '').split(' ');

  if (method === 'CONNECT') {
    const [host, port = '443'] = splitHostPort(target);
    try {
      const { socket: remote, link, tracked } = await dialOut(options, host, Number(port));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      splice(client, reader, remote, link, `${host}:${port}`, options, { tracked });
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    return;
  }

  if (/^http:\/\//i.test(target)) {
    let url;
    try {
      url = new URL(target);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const headers = lines.slice(1).filter((line) => line && !HOP_HEADERS.test(line));
    const request = [
      `${method} ${url.pathname}${url.search} ${version}`,
      ...headers,
      'Connection: close',
      '',
      '',
    ].join('\r\n');
    const port = Number(url.port || 80);
    try {
      const { socket: remote, link, tracked } = await dialOut(options, url.hostname, port);
      remote.write(request);
      splice(client, reader, remote, link, `${url.hostname}:${port}`, options, { extraBytesOut: request.length, tracked });
    } catch {
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    }
    return;
  }

  client.end(
    'HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n' +
      'braid is a proxy server. Point your applications at it as a SOCKS5, SOCKS4 or HTTP proxy.\r\n',
  );
}

async function dialOut(options, host, port) {
  // Tunnel mode: one app stream is split across links by the bonding server,
  // so a single connection gets the summed bandwidth. Direct mode: the whole
  // connection rides one chosen link.
  if (options.tunnel) return options.tunnel.open(host, port);
  const result = await dial(options, host, port, {
    onRetry: (link, err) =>
      options.log.warn(`  retrying ${host}:${port} on another link after ${link.name} failed (${err.code})`),
  });
  return { ...result, tracked: true };
}

// Wire the two sockets together. In direct mode we account per-link byte
// counts here; in tunnel mode (tracked=false) the tunnel client already
// counts bytes per subflow, so we must not double-count.
function splice(client, reader, remote, link, description, options, { extraBytesOut = 0, tracked = true } = {}) {
  const leftover = reader.drain();
  reader.detach();

  if (client.destroyed || remote.destroyed) {
    client.destroy();
    remote.destroy();
    return;
  }

  const { manager, log } = options;
  if (tracked) manager.track(link, remote);

  if (tracked) link.bytesOut += extraBytesOut;
  if (leftover.length) {
    if (tracked) link.bytesOut += leftover.length;
    remote.write(leftover);
  }

  if (tracked) {
    client.on('data', (chunk) => {
      link.bytesOut += chunk.length;
    });
    remote.on('data', (chunk) => {
      link.bytesIn += chunk.length;
    });
  }

  client.pipe(remote);
  remote.pipe(client);

  remote.on('error', () => {});
  const teardown = () => {
    client.destroy();
    remote.destroy();
  };
  client.on('close', teardown);
  remote.on('close', teardown);

  const via = tracked ? link.name : 'bond';
  const startedAt = Date.now();
  log.debug(`open  ${description} via ${via}`);
  remote.once('close', () => {
    log.debug(`close ${description} via ${via} (${Date.now() - startedAt} ms)`);
  });
}

function normalizeIp(address) {
  return address?.startsWith('::ffff:') ? address.slice(7) : (address ?? '127.0.0.1');
}

function ipBytes(address) {
  const parts = normalizeIp(address).split('.').map(Number);
  const valid = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  return valid ? parts : [127, 0, 0, 1];
}

function boundAddress(socket) {
  const parts = (socket.localAddress ?? '').split('.').map(Number);
  const valid = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  return {
    ip: valid ? parts : [0, 0, 0, 0],
    port: [(socket.localPort >> 8) & 0xff, socket.localPort & 0xff],
  };
}

function socks5ErrorCode(err) {
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
      return 0x04; // host unreachable
    case 'ECONNREFUSED':
      return 0x05;
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'ENOLINK':
      return 0x03; // network unreachable
    case 'EAFNOSUPPORT':
      return 0x08; // address type not supported
    default:
      return 0x01;
  }
}

function splitHostPort(value) {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value); // [::1]:443
  if (bracketed) return [bracketed[1], bracketed[2]];
  const at = value.lastIndexOf(':');
  // A second colon means a bare IPv6 literal with no port — keep it whole.
  if (at === -1 || value.indexOf(':') !== at) return [value, undefined];
  return [value.slice(0, at), value.slice(at + 1)];
}
