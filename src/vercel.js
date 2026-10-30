import { route } from './routes.js';
import { hasPassword, safeEqual } from './auth.js';
import { ConfigError } from './live.js';

// Vercel function handler for every /api route. Each route group has its
// own credential and fails closed if that credential is not configured:
//
//   /api/health          no auth, reports only whether the service is set up
//   /api/cron/*          Vercel cron, Authorization: Bearer CRON_SECRET
//   /api/inbound-email   email provider webhook, ?key=INBOUND_SECRET or Basic auth
//   everything else      dashboard, DASHBOARD_PASSWORD as Bearer or Basic
export function createHandler(env, makeApp) {
  let app;
  const getApp = () => (app ??= makeApp());

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const routeParam = url.searchParams.get('route');
      url.searchParams.delete('route');
      if (routeParam !== null) url.pathname = `/api/${routeParam}`;
      const path = url.pathname;
      const auth = req.headers.authorization ?? '';

      if (path === '/api/health') {
        let ok = true;
        try { getApp(); } catch { ok = false; }
        return send(res, ok ? 200 : 503, { ok });
      }

      if (path.startsWith('/api/cron/')) {
        if (!env.CRON_SECRET) return send(res, 503, { error: 'CRON_SECRET is not set.' });
        if (!safeEqual(auth, `Bearer ${env.CRON_SECRET}`)) return send(res, 401, { error: 'Unauthorised' });
        if (path === '/api/cron/release') return send(res, 200, await getApp().release());
        if (path === '/api/cron/reconcile') return send(res, 200, await getApp().reconcile());
        return send(res, 404, { error: 'not found' });
      }

      if (path === '/api/inbound-email') {
        if (!env.INBOUND_SECRET) return send(res, 503, { error: 'INBOUND_SECRET is not set.' });
        const key = url.searchParams.get('key');
        if (!safeEqual(key ?? '', env.INBOUND_SECRET) && !hasPassword(auth, env.INBOUND_SECRET)) {
          return send(res, 401, { error: 'Unauthorised' });
        }
      } else {
        if (!env.DASHBOARD_PASSWORD) return send(res, 503, { error: 'DASHBOARD_PASSWORD is not set. Add it in Vercel project settings, then redeploy.' });
        if (!hasPassword(auth, env.DASHBOARD_PASSWORD)) return send(res, 401, { error: 'Password required' });
      }

      return send(res, 200, await route(getApp(), req.method, url, () => readBody(req)));
    } catch (err) {
      if (err instanceof ConfigError) return send(res, 503, { error: err.message });
      console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error. Check the Vercel function logs.' });
    }
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString() || '{}');
    return req.body ?? {};
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw Object.assign(new Error('body too large'), { status: 413 });
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}
