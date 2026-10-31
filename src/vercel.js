import { route } from './routes.js';
import { passwordFromHeader, safeEqual } from './auth.js';
import { ConfigError, createLiveApp } from './live.js';
import { londonNow } from './clock.js';
import {
  SettingsStore, Sessions, isConfigured, ensureSetupCode, checkSetupCode, clearSetupCode, initialSettings, applySettingsChange, publicSettings,
  verifyPassword, hashPassword, loginAllowed, recordLoginFailure, userError, inboundUrlFor,
} from './settings.js';
import {
  normaliseSettings, siteView, putSiteView, findSite, findClient, findUser, findUserByEmail, legacyAdminPrincipal, userPrincipal,
  canSeeSite, visibleSites, canAct, canManage, canManageSite, canManageUser, managedClients, siteLive,
  publicUser, publicSite, publicClient, createUser, updateUser, deleteUser, createSite, updateSite,
  createClient, updateClient, deleteClient, ROLES,
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
//   /api/setup                       creates the first named admin; needs the code from the logs
//   /api/login, /api/logout          email and password -> session token
//   /api/cron/*                      scheduled jobs for every active site; time-gated and idempotent
//   /api/inbound-email               email webhook, ?key= identifies the site
//   /api/me, /api/me/password        the signed-in user
//   /api/clients                     groups that own sites; admins add, rename, archive, delete empty ones
//   /api/sites                       sites this user may see; admins and client admins add, rename, move, archive
//   /api/users, /api/audit           admins, and client admins for their own clients
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
      const raw = await store.get();
      let settings = normaliseSettings(raw);
      // Retired shared password hashes are removed from storage, not just ignored.
      if (raw.teamPasswordHash || (raw.adminPasswordHash && !settings.adminPasswordHash)) await store.save(settings);
      const configured = isConfigured(settings);
      const audit = new RedisActivity(redis, 'tr:install', { clock });

      if (path === '/api/setup-status') {
        if (!configured) await ensureSetupCode(redis, log);
        return send(res, 200, { needsSetup: !configured, oldAdminPassword: Boolean(settings.adminPasswordHash) });
      }

      // Creates the first named admin. On an existing install with no active
      // admin left, the same code is the way back in, and every client, site
      // and user is kept.
      if (path === '/api/setup' && method === 'POST') {
        if (configured) return send(res, 409, { error: 'Table Runner is already set up.' });
        const body = await readBody(req);
        await checkSetupCode(redis, body.code);
        const fresh = !settings.sites.length;
        const base = fresh ? normaliseSettings(initialSettings()) : settings;
        const r = await createUser(base, { name: body.name, email: body.email, password: body.password, role: 'admin' }, { at: clock(), actor: { role: 'admin' } });
        settings = normaliseSettings(r.settings);
        await store.save(settings);
        await clearSetupCode(redis);
        if (fresh) await createLiveApp({ redis, settings: siteView(settings, settings.sites[0].id), clock }).activity.add('settings', 'Table Runner set up');
        await audit.add('setup', `${fresh ? 'Table Runner set up' : 'Admin access restored with the setup code'}: ${r.user.email} is admin`, { by: 'setup code', clients: [] });
        const token = await sessions.create('admin', settings.sessionEpoch, { userId: r.user.id, userEpoch: r.user.epoch });
        return send(res, 200, { token, role: 'admin', name: r.user.name });
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
        // No email: only the old admin password of an install that has no
        // named admin yet. Shared passwords are otherwise retired.
        if (!settings.adminPasswordHash || !(await verifyPassword(password, settings.adminPasswordHash))) {
          await recordLoginFailure(redis, address);
          return send(res, 401, { error: 'Enter your email and password. Shared passwords are retired; ask an admin for your own sign-in.' });
        }
        return send(res, 200, { token: await sessions.create('admin', settings.sessionEpoch), role: 'admin', legacy: true });
      }

      const liveApp = (site) => createLiveApp({ redis, settings: siteView(settings, site.id), clock });
      const activeSites = settings.sites.filter((s) => siteLive(settings, s));

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
        if (!siteLive(settings, site)) return send(res, 403, { error: `${site.name} is archived; emails are not processed.` });
        return send(res, 200, await route(liveApp(site), method, url, () => readBody(req)));
      }

      const token = passwordFromHeader(req.headers.authorization ?? '');
      const session = await sessions.verify(token, settings.sessionEpoch);
      const principal = principalFor(settings, session);
      if (!principal) return send(res, 401, { error: 'Sign in required' });
      const isAdmin = principal.role === 'admin';
      const manager = canManage(principal);
      const by = principal.email ?? principal.name;
      const pubSite = (x, s = settings) => publicSite(x, s, { full: canManageSite(principal, x) });
      const logAdmin = (kind, message, clients) => audit.add(kind, message, { by, clients: clients.filter(Boolean) });
      const newTokenFor = (s) => (session.userId
        ? sessions.create(session.role, s.sessionEpoch, { userId: session.userId, userEpoch: findUser(s, session.userId).epoch })
        : sessions.create(session.role, s.sessionEpoch));

      if (path === '/api/logout' && method === 'POST') {
        await sessions.destroy(token);
        return send(res, 200, { ok: true });
      }

      if (path === '/api/me' && method === 'GET') {
        const sites = visibleSites(principal, settings);
        const clientIds = new Set([...sites.map((x) => x.clientId), ...principal.clients]);
        return send(res, 200, {
          ...meFor(principal),
          sites: sites.map((x) => publicSite(x, settings)),
          clients: settings.clients.filter((c) => clientIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, active: c.active })),
        });
      }

      if (path === '/api/me/password' && method === 'PUT') {
        if (!session.userId) return send(res, 400, { error: 'Shared passwords are changed by an admin on the Settings screen.' });
        const { currentPassword, newPassword } = await readBody(req);
        const user = findUser(settings, session.userId);
        if (!(await verifyPassword(currentPassword, user.passwordHash))) return send(res, 400, { error: 'Your current password is not correct.' });
        const r = await updateUser(settings, user.id, { password: newPassword }, { at: clock(), actor: principal });
        await store.save(r.settings);
        await logAdmin('user', `${user.email} changed their password`, user.clients);
        return send(res, 200, { ok: true, token: await newTokenFor(r.settings) });
      }

      if (path === '/api/clients' || path.startsWith('/api/clients/')) {
        const id = path.slice('/api/clients/'.length) || null;
        if (method === 'GET' && !id) {
          const visible = isAdmin ? settings.clients
            : settings.clients.filter((c) => principal.clients.includes(c.id) || visibleSites(principal, settings).some((x) => x.clientId === c.id));
          return send(res, 200, { clients: visible.map((c) => ({ ...publicClient(c, settings), canManage: managedClients(principal, settings).includes(c) })) });
        }
        const at = clock();
        let r;
        if (method === 'POST' && !id) {
          if (!isAdmin) return send(res, 403, { error: 'Only an admin can add clients.' });
          r = createClient(settings, await readBody(req), { at });
        } else if (method === 'PUT' && id) r = updateClient(settings, id, await readBody(req), { at, actor: principal });
        else if (method === 'DELETE' && id) {
          if (!isAdmin) return send(res, 403, { error: 'Only an admin can delete clients.' });
          r = deleteClient(settings, id);
        } else return send(res, 405, { error: 'method not allowed' });
        await store.save(r.settings);
        if (r.message) await logAdmin('client', r.message, [id ?? r.client.id]);
        return send(res, 200, r.client ? publicClient(r.client, r.settings) : { ok: true });
      }

      if (path === '/api/sites' || path.startsWith('/api/sites/')) {
        const id = path.slice('/api/sites/'.length) || null;
        if (method === 'GET' && !id) {
          return send(res, 200, { sites: visibleSites(principal, settings).map((x) => pubSite(x)) });
        }
        if (!manager) return send(res, 403, { error: 'Only an admin or client admin can add or change sites.' });
        const at = clock();
        let r;
        if (method === 'GET' && id) {
          const site = findSite(settings, id);
          return site && canManageSite(principal, site) ? send(res, 200, pubSite(site)) : send(res, 404, { error: 'Site not found.' });
        }
        if (method === 'POST' && !id) {
          r = createSite(settings, await readBody(req), { at, actor: principal });
          r.clients = [r.site.clientId];
        } else if (method === 'PUT' && id) r = updateSite(settings, id, await readBody(req), { at, actor: principal });
        else return send(res, 405, { error: 'method not allowed' });
        await store.save(r.settings);
        if (r.message) await logAdmin('site', r.message, r.clients);
        return send(res, 200, pubSite(r.site, r.settings));
      }

      if (path === '/api/users' || path.startsWith('/api/users/')) {
        if (!manager) return send(res, 403, { error: 'Only an admin or client admin can view or change users.' });
        const id = path.slice('/api/users/'.length) || null;
        if (method === 'GET' && !id) {
          const signIns = Object.fromEntries(((await redis.cmd('HVALS', SIGN_IN_KEY)) ?? []).map((v) => { const x = JSON.parse(v); return [x.id, x.at]; }));
          const clients = managedClients(principal, settings);
          const roles = isAdmin ? ROLES : Object.fromEntries(Object.entries(ROLES).filter(([k]) => k !== 'admin'));
          return send(res, 200, {
            roles,
            canGrantAll: isAdmin,
            clients: clients.map((c) => ({ id: c.id, name: c.name, active: c.active })),
            sites: settings.sites.filter((x) => canManageSite(principal, x)).map((x) => publicSite(x, settings)),
            users: settings.users.filter((u) => canManageUser(principal, u, settings))
              .map((u) => publicUser({ ...u, lastSignInAt: signIns[u.id] ?? null })),
          });
        }
        const actor = principal;
        let r;
        if (method === 'POST' && !id) r = await createUser(settings, await readBody(req), { at: clock(), actor });
        else if (method === 'PUT' && id) r = await updateUser(settings, id, await readBody(req), { at: clock(), actor });
        else if (method === 'DELETE' && id) r = deleteUser(settings, id, { actor });
        else return send(res, 405, { error: 'method not allowed' });
        await store.save(r.settings);
        if (r.message) await logAdmin('user', r.message, r.clients ?? []);
        return send(res, 200, r.user ? publicUser(r.user) : { ok: true });
      }

      if (path === '/api/audit' && method === 'GET') {
        if (!manager) return send(res, 403, { error: 'Only an admin or client admin can view the admin log.' });
        const log = await audit.list({ limit: 500 });
        // Client admins see entries about their own clients only.
        const mine = isAdmin ? log : log.filter((e) => (e.detail?.clients ?? []).some((c) => principal.clients.includes(c)));
        return send(res, 200, mine.slice(0, 200));
      }

      // Everything below works on one site.
      const wanted = url.searchParams.get('site');
      const site = wanted ? findSite(settings, wanted) : visibleSites(principal, settings).find((x) => siteLive(settings, x));
      if (wanted && (!site || !canSeeSite(principal, site, settings))) return send(res, 404, { error: `Site ${wanted} not found, or not one of yours.` });
      if (!site) return send(res, 403, { error: 'Your account has no sites yet. Ask an admin to give you one.' });
      const app = liveApp(site);

      if (path === '/api/settings') {
        if (!canManageSite(principal, site)) return send(res, 403, { error: 'Only an admin, or a client admin for this site, can view or change its settings.' });
        const origin = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
        const view = siteView(settings, site.id);
        const withSite = (s, v) => ({ site: publicSite(findSite(s, site.id), s), ...publicSettings(v, origin) });
        if (method === 'GET') return send(res, 200, withSite(settings, view));
        if (method === 'PUT') {
          const patch = await readBody(req);
          const { settings: nextView, changed } = await applySettingsChange(view, patch);
          await applyPostmark({ patch, prev: view, next: nextView, changed, origin, clock, fetchImpl });
          const next = putSiteView(settings, site.id, nextView);
          await store.save(next);
          if (changed.length) {
            await app.activity.add('settings', `Settings changed: ${changed.join(', ')}`);
            await logAdmin('settings', `${site.name}: settings changed: ${changed.join(', ')}`, [site.clientId]);
          }
          const body = { ...withSite(next, nextView), changed };
          return send(res, 200, body);
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      if (method !== 'GET' && !canAct(principal)) return send(res, 403, { error: 'Your account can view this site but not change anything.' });
      const result = await route(app, method, url, () => readBody(req));
      if (path === '/api/status') {
        const client = findClient(settings, site.clientId);
        return send(res, 200, { ...result, role: principal.role, site: site.id, client: client && { id: client.id, name: client.name }, user: meFor(principal) });
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
  if (!session.userId) return settings.adminPasswordHash && session.role === 'admin' ? legacyAdminPrincipal() : null;
  const user = findUser(settings, session.userId);
  if (!user || !user.active || user.epoch !== session.userEpoch) return null;
  return userPrincipal(user);
}

function meFor(p) {
  return { kind: p.kind, name: p.name, email: p.email ?? null, role: p.role, canAct: canAct(p), isAdmin: p.role === 'admin', canManage: canManage(p) };
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
