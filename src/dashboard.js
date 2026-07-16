import http from 'node:http';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('./dashboard.html', import.meta.url));
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export function createDashboard({ manager, capture, meta, onQuit }) {
  return http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const json = (code, body) => {
      res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    try {
      const host = req.headers.host ?? '';
      if (!LOOPBACK_HOST.test(host)) {
        json(421, { ok: false, error: 'dashboard is available on localhost only' });
        return;
      }
      if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }
      if (req.method === 'GET' && url === '/api/stats') {
        json(200, { ...meta(), ...manager.stats(), capture: capture.status() });
        return;
      }

      if (req.method === 'POST') {
        // The custom header forces a CORS preflight, which blocks other
        // origins (random websites) from poking the control API.
        if (req.headers['x-braid'] !== '1') {
          json(403, { ok: false, error: 'missing x-braid header' });
          return;
        }
        if (req.headers.origin && req.headers.origin !== `http://${host}`) {
          json(403, { ok: false, error: 'origin is not allowed' });
          return;
        }
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          json(400, { ok: false, error: 'invalid JSON body' });
          return;
        }
        if (url === '/api/strategy') {
          const result = manager.setStrategy(body.strategy);
          json(result.ok ? 200 : 400, result);
          return;
        }
        if (url === '/api/links/toggle') {
          const result = manager.toggleLink(body.name);
          json(result.ok ? 200 : 400, result);
          return;
        }
        if (url === '/api/capture/enable') {
          json(200, await capture.enable());
          return;
        }
        if (url === '/api/capture/disable') {
          json(200, await capture.disable());
          return;
        }
        if (url === '/api/quit') {
          const captureState = capture.status();
          const capturePresent = captureState.engineRunning || captureState.adapterUp;
          if (capturePresent && captureState.ownership !== 'other') {
            json(409, {
              ok: false,
              error: 'disable system-wide capture before quitting to avoid dropping the network',
            });
            return;
          }
          json(200, { ok: true });
          setTimeout(() => onQuit?.(), 200); // let the response flush first
          return;
        }
      }
      json(404, { ok: false, error: 'not found' });
    } catch (err) {
      json(500, { ok: false, error: err.message });
    }
  });
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
