import { route } from './routes.js';
import { passwordFromHeader, safeEqual } from './auth.js';
import { ConfigError, createLiveApp } from './live.js';
import { londonNow } from './clock.js';
import {
  SettingsStore, Sessions, isConfigured, ensureSetupCode, completeSetup, applySettingsChange, publicSettings,
  verifyPassword, hashPassword, loginAllowed, recordLoginFailure, userError, inboundUrlFor,
} from './settings.js';
import {
  normaliseSettings, siteView, putSiteView, findSite, findUser, findUserByEmail, sharedPrincipal, userPrincipal,
  canSeeSite, visibleSites, canAct, publicUser, publicSite, createUser, updateUser, deleteUser, createSite, updateSite, ROLES,
} from './directory.js';
import { RedisActivity } from './adapters/redis.js';
import { connectPostmark, assertPublic } from './postmark.js';

const RECONCILE_MIN_GAP_MS = 10 * 60 * 1000;
const SIGN_IN_KEY = 'tr:user-signin';
// Compared against when an email has no account, so a missing account takes
// as long to refuse as a wrong password.
const DUMMY_HASH = hashPassword('table-runner-no-such-user');

// Vercel function handler for every /api route. All settings come from the
// app's own storage; nothing is configured through environment variables.
//
//   /api/health, /api/setup-status   open; report only whether set up
//   /api/setup                       one time, needs the code from the logs
//   /api/login, /api/logout          email and password, or a shared password -> session token
//   /api/cron/*                      scheduled jobs for every active site; time-gated and idempotent
//   /api/inbound-email               email webhook, ?key= identifies the site
//   /api/me, /api/me/password        the signed-in user
//   /api/sites                       sites this user may see; admins add, rename, archive
//   /api/users, /api/audit           admin only
//   /api/settings?site=              admin only, one site's settings plus shared passwords
//   everything else                  dashboard for ?site= (default: first visible site)
export function createHandler({ getRedis, clock = () => londonNow(), log = console.log, fetchImpl = fetch }) {
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
      let settings = normaliseSettings(await store.get());
      const configured = isConfigured(settings);
      const audit = new RedisActivity(redis, 'tr:install', { clock });

      if (path === '/api/setup-status') {
        if (!configured) await ensureSetupCode(redis, log);
        return send(res, 200, { needsSetup: !configured });
      }

      if (path === '/api/setup' && method === 'POST') {
        settings = normaliseSettings(await completeSetup(redis, await readBody(req)));
        await store.save(settings);
        const site = settings.sites[0];
        await createLiveApp({ redis, settings: siteView(settings, site.id), clock }).activity.add('settings', 'Table Runner set up');
        await audit.add('setup', 'Table Runner set up', { by: 'setup code' });
        return send(res, 200, { token: await sessions.create('admin', settings.sessionEpoch), role: 'admin' });
      }

      if (!configured) return send(res, 503, { error: 'Table Runner is not set up yet. Open the dashboard to set it up.' });

      if (path === '/api/login' && method === 'POST') {
        const address = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
        if (!(await loginAllowed(redis, address))) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        const { email, password } = await readBody(req);
        if (email) {
          const user = findUserByEmail(settings, email);
          const ok = await verifyPassword(password, user?.passwordHash ?? await DUMMY_HASH);
          if (!user || !ok || !user.active) {
            await recordLoginFailure(redis, address);
            return send(res, 401, { error: user && ok && !user.active ? 'This account is disabled. Ask an admin.' : 'That email and password were not accepted.' });
          }
          const at = clock();
          await redis.cmd('HSET', SIGN_IN_KEY, user.id, JSON.stringify({ id: user.id, at }));
          const token = await sessions.create(user.role, settings.sessionEpoch, { userId: user.id, userEpoch: user.epoch });
          return send(res, 200, { token, role: user.role, name: user.name });
        }
        const role = (await verifyPassword(password, settings.adminPasswordHash)) ? 'admin'
          : (await verifyPassword(password, settings.teamPasswordHash)) ? 'team' : null;
        if (!role) {
          await recordLoginFailure(redis, address);
          return send(res, 401, { error: 'That password was not accepted.' });
        }
        return send(res, 200, { token: await sessions.create(role, settings.sessionEpoch), role });
      }

      const liveApp = (site) => createLiveApp({ redis, settings: siteView(settings, site.id), clock });
      const activeSites = settings.sites.filter((s) => s.active);

      if (path.startsWith('/api/cron/')) {
        // No secret needed: both jobs only act on what is already due and
        // repeat safely. Reconciliation is rate-limited per site so it cannot
        // be used to flood the alert channel. One site failing never stops
        // the others.
        const job = path === '/api/cron/release' ? (app) => app.release()
          : path === '/api/cron/reconcile' ? (app, site) => reconcileThrottled(app, redis, site.id) : null;
        if (!job) return send(res, 404, { error: 'not found' });
        const sites = [];
        for (const site of activeSites) {
          try {
            sites.push({ site: site.id, ok: true, result: await job(liveApp(site), site) });
          } catch (err) {
            console.error(`cron ${path} ${site.id}`, err);
            sites.push({ site: site.id, ok: false, error: err.message });
          }
        }
        return send(res, 200, { sites });
      }

      if (path === '/api/inbound-email') {
        const key = url.searchParams.get('key') ?? '';
        const site = settings.sites.find((s) => safeEqual(key, s.inboundSecret));
        if (!site) return send(res, 401, { error: 'Unauthorised' });
        // 403 tells Postmark to stop retrying.
        if (!site.active) return send(res, 403, { error: `${site.name} is archived; emails are not processed.` });
        return send(res, 200, await route(liveApp(site), method, url, () => readBody(req)));
      }

      const token = passwordFromHeader(req.headers.authorization ?? '');
      const session = await sessions.verify(token, settings.sessionEpoch);
      const principal = principalFor(settings, session);
      if (!principal) return send(res, 401, { error: 'Sign in required' });
      const isAdmin = principal.role === 'admin';
      const by = principal.email ?? principal.name;
      const newTokenFor = (s) => (session.userId
        ? sessions.create(session.role, s.sessionEpoch, { userId: session.userId, userEpoch: findUser(s, session.userId).epoch })
        : sessions.create(session.role, s.sessionEpoch));

      if (path === '/api/logout' && method === 'POST') {
        await sessions.destroy(token);
        return send(res, 200, { ok: true });
      }

      if (path === '/api/me' && method === 'GET') {
        return send(res, 200, { ...meFor(principal), sites: visibleSites(principal, settings).map((s) => publicSite(s)) });
      }

      if (path === '/api/me/password' && method === 'PUT') {
        if (!session.userId) return send(res, 400, { error: 'Shared passwords are changed by an admin on the Settings screen.' });
        const { currentPassword, newPassword } = await readBody(req);
        const user = findUser(settings, session.userId);
        if (!(await verifyPassword(currentPassword, user.passwordHash))) return send(res, 400, { error: 'Your current password is not correct.' });
        const r = await updateUser(settings, user.id, { password: newPassword }, { at: clock(), actor: principal });
        await store.save(r.settings);
        await audit.add('user', `${user.email} changed their password`, { by });
        return send(res, 200, { ok: true, token: await newTokenFor(r.settings) });
      }

      if (path === '/api/sites' || path.startsWith('/api/sites/')) {
        const id = path.slice('/api/sites/'.length) || null;
        if (method === 'GET' && !id) {
          return send(res, 200, { sites: visibleSites(principal, settings).map((s) => publicSite(s, { full: isAdmin })) });
        }
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can add or change sites.' });
        const body = method === 'GET' ? {} : await readBody(req);
        let r;
        if (method === 'POST' && !id) r = createSite(settings, body, { at: clock() });
        else if (method === 'PUT' && id) r = updateSite(settings, id, body, { at: clock() });
        else if (method === 'GET' && id) {
          const site = findSite(settings, id);
          return site ? send(res, 200, publicSite(site, { full: true })) : send(res, 404, { error: 'Site not found.' });
        } else return send(res, 405, { error: 'method not allowed' });
        await store.save(r.settings);
        if (r.message) await audit.add('site', r.message, { by, site: r.site.id });
        return send(res, 200, publicSite(r.site, { full: true }));
      }

      if (path === '/api/users' || path.startsWith('/api/users/')) {
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can view or change users.' });
        const id = path.slice('/api/users/'.length) || null;
        if (method === 'GET' && !id) {
          const signIns = Object.fromEntries(((await redis.cmd('HVALS', SIGN_IN_KEY)) ?? []).map((v) => { const x = JSON.parse(v); return [x.id, x.at]; }));
          return send(res, 200, {
            roles: ROLES,
            sites: settings.sites.map((s) => publicSite(s)),
            users: settings.users.map((u) => publicUser({ ...u, lastSignInAt: signIns[u.id] ?? null })),
          });
        }
        const actor = principal;
        let r;
        if (method === 'POST' && !id) r = await createUser(settings, await readBody(req), { at: clock() });
        else if (method === 'PUT' && id) r = await updateUser(settings, id, await readBody(req), { at: clock(), actor });
        else if (method === 'DELETE' && id) r = deleteUser(settings, id, { actor });
        else return send(res, 405, { error: 'method not allowed' });
        await store.save(r.settings);
        if (r.message) await audit.add('user', r.message, { by });
        return send(res, 200, r.user ? publicUser(r.user) : { ok: true });
      }

      if (path === '/api/audit' && method === 'GET') {
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can view the admin log.' });
        return send(res, 200, await audit.list({ limit: 200 }));
      }

      // Everything below works on one site.
      const wanted = url.searchParams.get('site');
      const site = wanted ? findSite(settings, wanted) : visibleSites(principal, settings).find((s) => s.active);
      if (wanted && (!site || !canSeeSite(principal, site))) return send(res, 404, { error: `Site ${wanted} not found, or not one of yours.` });
      if (!site) return send(res, 403, { error: 'Your account has no sites yet. Ask an admin to give you one.' });
      const app = liveApp(site);

      if (path === '/api/settings') {
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can view or change settings.' });
        const origin = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
        const view = siteView(settings, site.id);
        const withSite = (s, v) => ({ site: publicSite(findSite(s, site.id)), ...publicSettings(v, origin) });
        if (method === 'GET') return send(res, 200, withSite(settings, view));
        if (method === 'PUT') {
          const patch = await readBody(req);
          const { settings: nextView, changed } = await applySettingsChange(view, patch);
          await applyPostmark({ patch, prev: view, next: nextView, changed, origin, clock, fetchImpl });
          const next = putSiteView(settings, site.id, nextView);
          await store.save(next);
          if (changed.length) {
            await app.activity.add('settings', `Settings changed: ${changed.join(', ')}`);
            await audit.add('settings', `${site.name}: settings changed: ${changed.join(', ')}`, { by, site: site.id });
          }
          const body = { ...withSite(next, nextView), changed };
          // A shared password change signs everyone out; keep this admin signed in.
          if (next.sessionEpoch !== settings.sessionEpoch) body.token = await newTokenFor(next);
          return send(res, 200, body);
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      if (method !== 'GET' && !canAct(principal)) return send(res, 403, { error: 'Your account can view this site but not change anything.' });
      const result = await route(app, method, url, () => readBody(req));
      if (path === '/api/status') {
        return send(res, 200, { ...result, role: principal.role, site: site.id, user: meFor(principal) });
      }
      return send(res, 200, result);
    } catch (err) {
      if (err instanceof ConfigError) return send(res, 503, { error: err.message });
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error. Check the Vercel function logs.' });
    }
  };
}

// The signed-in principal, or null when the session no longer stands: a
// named user who was disabled, deleted, or had their access changed.
function principalFor(settings, session) {
  if (!session) return null;
  if (!session.userId) return sharedPrincipal(session.role);
  const user = findUser(settings, session.userId);
  if (!user || !user.active || user.epoch !== session.userEpoch) return null;
  return userPrincipal(user);
}

function meFor(p) {
  return { kind: p.kind, name: p.name, email: p.email ?? null, role: p.role, canAct: canAct(p), isAdmin: p.role === 'admin' };
}

// Connects Postmark when a token is given, and keeps it pointed at the
// current webhook key when the key is regenerated. Runs before anything is
// saved, so a Postmark failure leaves the settings unchanged.
async function applyPostmark({ patch, prev, next, changed, origin, clock, fetchImpl }) {
  if (patch.disconnectPostmark && next.postmark) {
    delete next.postmark;
    changed.push('Postmark disconnected');
    return;
  }
  const newToken = typeof patch.postmarkServerToken === 'string' ? patch.postmarkServerToken.trim() : '';
  const keyChanged = next.inboundSecret !== prev.inboundSecret;
  const token = newToken || (keyChanged ? next.postmark?.serverToken : '');
  if (!token) return;

  const hookUrl = inboundUrlFor(next, origin);
  await assertPublic(origin, fetchImpl);
  const server = await connectPostmark({ token, hookUrl, fetchImpl });
  next.postmark = { serverToken: token, ...server, hookUrl, connectedAt: clock() };
  changed.push(newToken ? 'Postmark connected' : 'Postmark webhook updated');
}

// At most one reconciliation per site per ten minutes, across all instances.
async function reconcileThrottled(app, redis, siteId) {
  const ok = await redis.cmd('SET', `tr:reconcile-throttle:${siteId}`, '1', 'NX', 'PX', RECONCILE_MIN_GAP_MS);
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
