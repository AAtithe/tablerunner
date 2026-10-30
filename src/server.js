import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { route, httpError } from './routes.js';
import { hasPassword } from './auth.js';

const INDEX = new URL('../public/index.html', import.meta.url);

// Dashboard and JSON API. The dashboard shows guest names and contact
// details, so set DASHBOARD_PASSWORD whenever it is reachable beyond
// localhost (HTTP Basic auth, any username).
export function createDashboardServer(app, { password } = {}) {
  return createServer(async (req, res) => {
    try {
      if (password && !hasPassword(req.headers.authorization, password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="Table Runner"' });
        return res.end('Authentication required');
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(INDEX));
      }
      return json(res, await route(app, req.method, url, () => readJson(req)));
    } catch (err) {
      json(res, { error: err.message }, err.status ?? 500);
    }
  });
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw httpError(413, 'body too large');
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}
