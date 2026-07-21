import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDashboard } from '../src/dashboard.js';

function request(port, { method = 'GET', path = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withDashboard(run, { captureStatus } = {}) {
  const manager = {
    stats: () => ({ links: [], events: [] }),
    setStrategy: (strategy) => ({ ok: true, strategy }),
    toggleLink: (name) => ({ ok: true, name, enabled: false }),
    setWeight: (name, weight) => (Number.isFinite(weight) && weight >= 1
      ? { ok: true, name, weight }
      : { ok: false, error: 'weight must be a number between 1 and 100' }),
  };
  const capture = {
    status: () => captureStatus ?? ({ active: false, adapterUp: false, engineRunning: false, ownership: 'none' }),
    enable: async () => ({ ok: true }),
    disable: async () => ({ ok: true }),
  };
  const autostart = {
    status: () => ({ supported: true, enabled: false }),
    setEnabled: async (enabled) => ({ ok: true, enabled }),
  };
  const wifi = {
    status: () => ({ supported: true, enabled: false, detail: 'off', policy: 'default' }),
    setEnabled: (enabled) => ({ ok: true, enabled }),
    fixPolicy: async () => ({ ok: true, policy: 'applied' }),
  };
  const tunnelControl = {
    status: () => ({ enabled: false, saved: null }),
    configure: ({ host, port }) => (host && Number.isInteger(Number(port))
      ? { ok: true, server: `${host}:${port}` }
      : { ok: false, error: 'enter the braid-server host name or IP' }),
    disable: () => ({ ok: true, enabled: false }),
  };
  const server = createDashboard({
    manager,
    capture,
    autostart,
    wifi,
    tunnelControl,
    meta: () => ({ version: 'test', strategies: [], proxy: '127.0.0.1:1080' }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves the dashboard with hardened browser headers', async () => {
  await withDashboard(async (port) => {
    const response = await request(port, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/html/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(response.headers['content-security-policy'], /frame-ancestors 'none'/);
  });
});

test('rejects rebinding hosts and cross-origin control requests', async () => {
  await withDashboard(async (port) => {
    const rebound = await request(port, { headers: { host: 'attacker.example' } });
    assert.equal(rebound.status, 421);

    const crossOrigin = await request(port, {
      method: 'POST',
      path: '/api/strategy',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'https://attacker.example',
        'content-type': 'application/json',
        'x-braid': '1',
      },
      body: JSON.stringify({ strategy: 'balanced' }),
    });
    assert.equal(crossOrigin.status, 403);
  });
});

test('accepts same-origin API requests with the control header', async () => {
  await withDashboard(async (port) => {
    const response = await request(port, {
      method: 'POST',
      path: '/api/strategy',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        'x-braid': '1',
      },
      body: JSON.stringify({ strategy: 'failover' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, strategy: 'failover' });
  });
});

test('sets and validates link weights over the control API', async () => {
  await withDashboard(async (port) => {
    const headers = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-braid': '1',
    };
    const accepted = await request(port, {
      method: 'POST',
      path: '/api/links/weight',
      headers,
      body: JSON.stringify({ name: 'Wi-Fi', weight: 4 }),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), { ok: true, name: 'Wi-Fi', weight: 4 });

    const rejected = await request(port, {
      method: 'POST',
      path: '/api/links/weight',
      headers,
      body: JSON.stringify({ name: 'Wi-Fi', weight: 'heavy' }),
    });
    assert.equal(rejected.status, 400);
    assert.equal(JSON.parse(rejected.body).ok, false);
  });
});

test('exposes and toggles autostart and wifi assist', async () => {
  await withDashboard(async (port) => {
    const headers = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-braid': '1',
    };
    const stats = await request(port, { path: '/api/stats', headers: { host: `127.0.0.1:${port}` } });
    const parsed = JSON.parse(stats.body);
    assert.deepEqual(parsed.autostart, { supported: true, enabled: false });
    assert.equal(parsed.wifiAssist.supported, true);

    const autostartOn = await request(port, {
      method: 'POST',
      path: '/api/autostart',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(autostartOn.status, 200);
    assert.deepEqual(JSON.parse(autostartOn.body), { ok: true, enabled: true });

    const wifiOn = await request(port, {
      method: 'POST',
      path: '/api/wifi-assist',
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(wifiOn.status, 200);
    assert.deepEqual(JSON.parse(wifiOn.body), { ok: true, enabled: true });
  });
});

test('configures and disables the bonding server over the control API', async () => {
  await withDashboard(async (port) => {
    const headers = {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-braid': '1',
    };
    const connect = await request(port, {
      method: 'POST',
      path: '/api/tunnel',
      headers,
      body: JSON.stringify({ host: 'vps.example.com', port: 7000, secret: 'x' }),
    });
    assert.equal(connect.status, 200);
    assert.deepEqual(JSON.parse(connect.body), { ok: true, server: 'vps.example.com:7000' });

    const invalid = await request(port, {
      method: 'POST',
      path: '/api/tunnel',
      headers,
      body: JSON.stringify({ host: '', port: 7000 }),
    });
    assert.equal(invalid.status, 400);

    const off = await request(port, {
      method: 'POST',
      path: '/api/tunnel',
      headers,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(off.status, 200);
    assert.deepEqual(JSON.parse(off.body), { ok: true, enabled: false });

    const policy = await request(port, {
      method: 'POST',
      path: '/api/wifi-policy',
      headers,
      body: '{}',
    });
    assert.equal(policy.status, 200);
    assert.deepEqual(JSON.parse(policy.body), { ok: true, policy: 'applied' });
  });
});

test('refuses to quit while this instance may own system capture', async () => {
  await withDashboard(async (port) => {
    const response = await request(port, {
      method: 'POST',
      path: '/api/quit',
      headers: {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        'x-braid': '1',
      },
      body: '{}',
    });
    assert.equal(response.status, 409);
    assert.match(JSON.parse(response.body).error, /disable system-wide capture/i);
  }, {
    captureStatus: { adapterUp: true, engineRunning: true, ownership: 'this' },
  });
});
