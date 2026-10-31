import { route } from './routes.js';
import { passwordFromHeader, safeEqual } from './auth.js';
import { ConfigError, createLiveApp } from './live.js';
import { londonNow } from './clock.js';
import { secretKeyFromEnv } from './secrets.js';
import {
  SettingsStore, Sessions, isConfigured, ensureSetupCode, completeSetup, applySettingsChange, publicSettings,
  verifyPassword, loginAllowed, recordLoginFailure, userError,
} from './settings.js';

const RECONCILE_MIN_GAP_MS = 10 * 60 * 1000;

// Vercel function handler for every /api route. All settings come from the
// app's own storage. The one exception is TABLE_RUNNER_SECRET_KEY, which
// encrypts the SevenRooms client secret and must not sit in the same database.
//
//   /api/health, /api/setup-status   open; report only whether set up
//   /api/setup                       one time, needs the code from the logs
//   /api/login, /api/logout          team or admin password -> session token
//   /api/cron/*                      scheduled jobs; time-gated and idempotent
//   /api/inbound-email               email webhook, ?key= from Settings
//   /api/settings                    admin session only
//   everything else                  team or admin session
export function createHandler({ getRedis, clock = () => londonNow(), log = console.log, secretKey = secretKeyFromEnv(process.env) }) {
  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const routeParam = url.searchParams.get('route');
      url.searchParams.delete('route');
      if (routeParam !== null) url.pathname = `/api/${routeParam}`;
      const path = url.pathname;
      const method = req.method;

      if (path === '/api/health') {
        try {
          const settings = await new SettingsStore(getRedis()).get();
          return send(res, 200, { ok: true, setUp: isConfigured(settings) });
        } catch {
          return send(res, 503, { ok: false });
        }
      }

      const redis = getRedis();
      const store = new SettingsStore(redis);
      const sessions = new Sessions(redis);
      let settings = await store.get();
      const configured = isConfigured(settings);

      if (path === '/api/setup-status') {
        if (!configured) await ensureSetupCode(redis, log);
        return send(res, 200, { needsSetup: !configured });
      }

      if (path === '/api/setup' && method === 'POST') {
        settings = await completeSetup(redis, await readBody(req));
        const app = createLiveApp({ redis, settings, clock, secretKey });
        await app.activity.add('settings', 'Table Runner set up');
        return send(res, 200, { token: await sessions.create('admin', settings.sessionEpoch), role: 'admin' });
      }

      if (!configured) return send(res, 503, { error: 'Table Runner is not set up yet. Open the dashboard to set it up.' });

      if (path === '/api/login' && method === 'POST') {
        const address = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
        if (!(await loginAllowed(redis, address))) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        const { password } = await readBody(req);
        const role = (await verifyPassword(password, settings.adminPasswordHash)) ? 'admin'
          : (await verifyPassword(password, settings.teamPasswordHash)) ? 'team' : null;
        if (!role) {
          await recordLoginFailure(redis, address);
          return send(res, 401, { error: 'That password was not accepted.' });
        }
        return send(res, 200, { token: await sessions.create(role, settings.sessionEpoch), role });
      }

      const app = createLiveApp({ redis, settings, clock, secretKey });

      if (path.startsWith('/api/cron/')) {
        // No secret needed: both jobs only act on what is already due and
        // repeat safely. Reconciliation is rate-limited so it cannot be used
        // to flood the alert channel.
        if (path === '/api/cron/release') return send(res, 200, await app.release());
        if (path === '/api/cron/reconcile') return send(res, 200, await reconcileThrottled(app, redis));
        return send(res, 404, { error: 'not found' });
      }

      if (path === '/api/inbound-email') {
        if (!safeEqual(url.searchParams.get('key') ?? '', settings.inboundSecret)) return send(res, 401, { error: 'Unauthorised' });
        return send(res, 200, await route(app, method, url, () => readBody(req)));
      }

      const token = passwordFromHeader(req.headers.authorization ?? '');
      const role = await sessions.verify(token, settings.sessionEpoch);
      if (!role) return send(res, 401, { error: 'Sign in required' });

      if (path === '/api/logout' && method === 'POST') {
        await sessions.destroy(token);
        return send(res, 200, { ok: true });
      }

      if (path === '/api/settings') {
        if (role !== 'admin') return send(res, 403, { error: 'Only an admin can view or change settings.' });
        const origin = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
        if (method === 'GET') return send(res, 200, publicSettings(settings, origin, { secretKey }));
        if (method === 'PUT') {
          const { settings: next, changed } = await applySettingsChange(settings, await readBody(req), { secretKey });
          await store.save(next);
          if (changed.length) await app.activity.add('settings', `Settings changed: ${changed.join(', ')}`);
          const body = { ...publicSettings(next, origin, { secretKey }), changed };
          // A password change signs everyone out; keep this admin signed in.
          if (next.sessionEpoch !== settings.sessionEpoch) body.token = await sessions.create('admin', next.sessionEpoch);
          return send(res, 200, body);
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      const result = await route(app, method, url, () => readBody(req));
      return send(res, 200, path === '/api/status' ? { ...result, role } : result);
    } catch (err) {
      if (err instanceof ConfigError) return send(res, 503, { error: err.message });
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error. Check the Vercel function logs.' });
    }
  };
}

// At most one reconciliation per ten minutes, across all instances.
async function reconcileThrottled(app, redis) {
  const ok = await redis.cmd('SET', 'tr:reconcile-throttle', '1', 'NX', 'PX', RECONCILE_MIN_GAP_MS);
  if (ok !== 'OK') return { skipped: 'ran in the last 10 minutes' };
  return app.reconcile();
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return parseJson(req.body);
    if (Buffer.isBuffer(req.body)) return parseJson(req.body.toString());
    return req.body ?? {};
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw userError(413, 'body too large');
  }
  return parseJson(raw);
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw userError(400, 'invalid JSON');
  }
}
