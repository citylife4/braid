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
  };
  const capture = {
    status: () => captureStatus ?? ({ active: false, adapterUp: false, engineRunning: false, ownership: 'none' }),
    enable: async () => ({ ok: true }),
    disable: async () => ({ ok: true }),
  };
  const server = createDashboard({
    manager,
    capture,
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
