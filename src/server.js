import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

const INDEX = new URL('../public/index.html', import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Dashboard and JSON API. The dashboard shows guest names and contact
// details, so set DASHBOARD_PASSWORD whenever it is reachable beyond
// localhost (HTTP Basic auth, any username).
export function createDashboardServer(app, { password } = {}) {
  return createServer(async (req, res) => {
    try {
      if (password && !authorised(req, password)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="openroomst"' });
        return res.end('Authentication required');
      }
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      const today = app.status().now.slice(0, 10);
      const date = (name) => {
        const v = url.searchParams.get(name) ?? today;
        if (!DATE.test(v)) throw httpError(400, `${name} must be YYYY-MM-DD`);
        return v;
      };

      if (route === 'GET /') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(await readFile(INDEX));
      }
      if (route === 'GET /api/status') return json(res, app.status());
      if (route === 'GET /api/day') return json(res, await app.dayView(date('date')));
      if (route === 'GET /api/week') return json(res, await app.weekView(date('from'), 7));
      if (route === 'GET /api/alerts') {
        const all = url.searchParams.get('all') === '1';
        return json(res, (all ? app.alerts.sent : app.alerts.open()).slice().reverse());
      }
      if (route === 'GET /api/activity') return json(res, app.activity.list({ limit: 100 }));
      if (route === 'POST /api/reconcile') return json(res, await app.reconcile());
      if (route === 'POST /api/release') return json(res, await app.release());
      if (route === 'POST /api/inbound-email') {
        const body = await readJson(req);
        return json(res, await app.ingestEmail({ subject: String(body.subject ?? ''), text: String(body.text ?? '') }));
      }
      const ack = route.match(/^POST \/api\/alerts\/(\d+)\/ack$/);
      if (ack) {
        const a = app.alerts.acknowledge(Number(ack[1]));
        if (!a) throw httpError(404, 'alert not found');
        app.activity.add('alert.ack', `Alert ${a.id} acknowledged: ${a.code}`);
        return json(res, a);
      }
      throw httpError(404, 'not found');
    } catch (err) {
      json(res, { error: err.message }, err.status ?? 500);
    }
  });
}

function authorised(req, password) {
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const given = Buffer.from(Buffer.from(token, 'base64').toString().split(':').slice(1).join(':'));
  const expected = Buffer.from(password);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
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
