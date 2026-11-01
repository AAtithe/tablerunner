import { route } from './routes.js';
import { actorRecord } from './alert.js';
import { passwordFromHeader, safeEqual } from './auth.js';
import { ConfigError, createLiveApp } from './live.js';
import { loadKeyring, saveKeyring, pruneKeyring, encryptSecret } from './secrets.js';
import { londonNow } from './clock.js';
import {
  SettingsStore, Sessions, isConfigured, rotateEncryptionKey, encryptPlainSecrets, readSecret, POSTMARK_TOKEN_FIELD, ensureSetupCode, checkSetupCode, clearSetupCode, initialSettings, applySettingsChange, publicSettings,
  verifyPassword, hashPassword, loginAllowed, recordLoginFailure, userError, inboundUrlFor, withStartingHoldBack,
} from './settings.js';
import {
  normaliseSettings, siteView, putSiteView, findSite, findClient, findUser, findUserByEmail, legacyAdminPrincipal, userPrincipal,
  canSeeSite, visibleSites, canAct, canManage, canManageSite, canManageUser, managedClients, siteLive,
  publicUser, publicSite, publicClient, createUser, updateUser, deleteUser, createSite, updateSite,
  createClient, updateClient, deleteClient, issueLink, acceptLink, accessNames, activeAdmins, ROLES,
} from './directory.js';
import {
  sendEmail, applyMailChange, publicMail, createLink, readLink, deleteLink, inviteMessage, resetMessage, testMessage, LINK_TTL_S,
} from './mail.js';
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
//   /api/link, /api/link/accept      open; an emailed invite or reset link sets a password
//   /api/password-reset              open; emails a reset link (always answers the same)
//   /api/me, /api/me/password        the signed-in user
//   /api/admin/overview              counts and what needs attention, scoped to the user
//   /api/mail                        admin only: Postmark sending, test, message previews
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
      let keyring = await loadKeyring(redis);
      // Tokens saved in plain text before encryption existed are encrypted
      // once, on the first request after this version is deployed. The admin
      // log records how many, as evidence the conversion ran; never the values.
      const sealed = encryptPlainSecrets(settings, keyring);
      if (sealed) {
        settings = sealed.settings;
        await store.save(settings);
        await audit.add('settings', `${sealed.count} saved secret(s) found in plain text and encrypted at rest`, { by: 'Table Runner', clients: [] });
      }

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
        if (fresh) await createLiveApp({ redis, settings: siteView(settings, settings.sites[0].id), clock, keyring }).activity.add('settings', 'Table Runner set up');
        await audit.add('setup', `${fresh ? 'Table Runner set up' : 'Admin access restored with the setup code'}: ${r.user.email} is admin`, { by: 'setup code', clients: [] });
        await redis.cmd('HSET', SIGN_IN_KEY, r.user.id, JSON.stringify({ id: r.user.id, at: clock() }));
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

      const origin = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers['x-forwarded-host'] ?? req.headers.host}`;
      const address = String(req.headers['x-forwarded-for'] ?? 'unknown').split(',')[0].trim();
      const appUrl = () => settings.mail?.appUrl ?? origin;

      // Issues a link for a user and emails it. Returns the settings to save;
      // nothing is saved when Postmark refuses, so no orphan links exist.
      async function emailLink(current, userId, { kind, inviter }) {
        const issued = issueLink(current, userId, { at: clock(), kind });
        const token = await createLink(redis, { kind, userId, nonce: issued.user.linkNonce });
        const link = `${appUrl()}/?link=${token}`;
        const message = kind === 'invite'
          ? inviteMessage({ name: issued.user.name, email: issued.user.email, inviter, access: accessNames(current, issued.user), link })
          : resetMessage({ name: issued.user.name, email: issued.user.email, link });
        try {
          await sendEmail(current.mail, { to: issued.user.email, ...message }, { fetchImpl, keyring });
        } catch (err) {
          await deleteLink(redis, token);
          throw err;
        }
        return issued;
      }

      if (path === '/api/link' && method === 'GET') {
        const record = await readLink(redis, url.searchParams.get('token'));
        const user = record && findUser(settings, record.userId);
        if (!record || !user || !user.active || user.linkNonce !== record.nonce) {
          return send(res, 410, { error: 'This link has expired or has already been used. Ask your admin to send a new one.' });
        }
        return send(res, 200, { kind: record.kind, name: user.name, email: user.email });
      }

      if (path === '/api/link/accept' && method === 'POST') {
        if (!(await loginAllowed(redis, address))) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        const { token, password } = await readBody(req);
        const record = await readLink(redis, token);
        if (!record) {
          await recordLoginFailure(redis, address);
          return send(res, 410, { error: 'This link has expired or has already been used. Ask your admin to send a new one.' });
        }
        const r = await acceptLink(settings, record, password, { at: clock() });
        await store.save(r.settings);
        await deleteLink(redis, token);
        await redis.cmd('HSET', SIGN_IN_KEY, r.user.id, JSON.stringify({ id: r.user.id, at: clock() }));
        await audit.add('user', record.kind === 'invite' ? `${r.user.email} accepted their invite` : `${r.user.email} reset their password`, { by: r.user.email, clients: clientsOf(settings, r.user) });
        const token2 = await sessions.create(r.user.role, settings.sessionEpoch, { userId: r.user.id, userEpoch: r.user.epoch });
        return send(res, 200, { token: token2, role: r.user.role, name: r.user.name });
      }

      // Always the same answer, so it cannot be used to find out who has an account.
      if (path === '/api/password-reset' && method === 'POST') {
        const answer = { ok: true, message: 'If that email has an active account, a reset link is on its way. It expires in 1 hour. If nothing arrives, ask your admin.' };
        if (!(await loginAllowed(redis, address))) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes and try again.' });
        await recordLoginFailure(redis, address);
        const { email } = await readBody(req);
        const user = findUserByEmail(settings, email ?? '');
        if (user?.active && settings.mail?.serverToken) {
          try {
            const issued = await emailLink(settings, user.id, { kind: 'reset' });
            await store.save(issued.settings);
            await audit.add('user', `Password reset link sent to ${user.email}`, { by: user.email, clients: clientsOf(settings, user) });
          } catch (err) {
            console.error('password reset email', err.message);
          }
        }
        return send(res, 200, answer);
      }

      const liveApp = (site) => createLiveApp({ redis, settings: siteView(settings, site.id), clock, keyring });

      // Floor plans saved before the OpenTable reserve existed get the
      // starting reserve once, site by site; a figure an admin set is kept.
      const migratedSites = settings.sites.filter((x) => withStartingHoldBack({ floorPlan: x.floorPlan }));
      if (migratedSites.length) {
        settings = { ...settings, sites: settings.sites.map((x) => withStartingHoldBack({ floorPlan: x.floorPlan }) ? { ...x, floorPlan: withStartingHoldBack({ floorPlan: x.floorPlan }).floorPlan } : x) };
        await store.save(settings);
        for (const x of migratedSites) {
          const plan = findSite(settings, x.id).floorPlan;
          await liveApp(x).activity.add('settings', `Settings changed: OpenTable reserve set to the starting figures ${JSON.stringify(plan.release.holdBack)}`);
        }
      }
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
      // Who acknowledged an alert or changed a site's settings, for the site activity.
      const signedIn = actorRecord(principal);
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
            mailConnected: Boolean(settings.mail?.serverToken),
            clients: clients.map((c) => ({ id: c.id, name: c.name, active: c.active })),
            sites: settings.sites.filter((x) => canManageSite(principal, x)).map((x) => publicSite(x, settings)),
            users: settings.users.filter((u) => canManageUser(principal, u, settings))
              .map((u) => publicUser({ ...u, lastSignInAt: signIns[u.id] ?? null })),
          });
        }
        const actor = principal;
        const inviter = principal.name;
        const linkFor = id?.match(/^([^/]+)\/link$/);
        if (linkFor && method === 'POST') {
          const user = findUser(settings, linkFor[1]);
          if (!user || !canManageUser(principal, user, settings)) return send(res, 404, { error: 'User not found.' });
          const kind = user.passwordHash ? 'reset' : 'invite';
          const issued = await emailLink(settings, user.id, { kind, inviter });
          await store.save(issued.settings);
          await logAdmin('user', `${kind === 'invite' ? 'Invite' : 'Password reset link'} sent to ${user.email}`, clientsOf(settings, user));
          return send(res, 200, { ...publicUser(issued.user), sent: kind });
        }
        let r;
        if (method === 'POST' && !id) {
          const body = await readBody(req);
          if (body.invite && !body.password && !settings.mail?.serverToken) {
            return send(res, 400, { error: 'Email sending is not set up yet, so an invite cannot be sent. Set it up on the Email tab, or give this user a password now.' });
          }
          r = await createUser(settings, body, { at: clock(), actor });
          if (body.invite && !body.password) {
            // Email first; the user is saved only once the invite is on its way.
            const issued = await emailLink(r.settings, r.user.id, { kind: 'invite', inviter });
            r = { ...r, settings: issued.settings, user: issued.user, message: `${r.message}, invite emailed` };
          }
        }
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

      if (path === '/api/admin/overview' && method === 'GET') {
        if (!manager) return send(res, 403, { error: 'Only an admin or client admin can view the admin overview.' });
        return send(res, 200, await overview({ settings, principal, isAdmin, audit, clock }));
      }

      if (path === '/api/mail' || path.startsWith('/api/mail/')) {
        if (path === '/api/mail/preview' && method === 'GET') {
          if (!manager) return send(res, 403, { error: 'Only an admin or client admin can preview emails.' });
          const kind = url.searchParams.get('kind') === 'reset' ? 'reset' : 'invite';
          const link = `${appUrl()}/?link=example-link`;
          const sample = { name: 'Sam Patel', email: 'sam@venue.co', inviter: principal.name, access: ['Open House (all sites)'], link };
          return send(res, 200, kind === 'invite' ? inviteMessage(sample) : resetMessage(sample));
        }
        if (!isAdmin) return send(res, 403, { error: 'Only an admin can set up email sending.' });
        if (path === '/api/mail' && method === 'GET') return send(res, 200, { ...publicMail(settings.mail), suggestedAppUrl: origin });
        if (path === '/api/mail' && method === 'PUT') {
          const { mail, changed } = await applyMailChange(settings.mail, await readBody(req), { origin, at: clock(), fetchImpl, keyring });
          const next = { ...settings, mail };
          if (!mail) delete next.mail;
          await store.save(next);
          if (changed.length) await logAdmin('mail', `Email sending: ${changed.join(', ')}`, []);
          return send(res, 200, { ...publicMail(mail), changed, suggestedAppUrl: origin });
        }
        if (path === '/api/mail/test' && method === 'POST') {
          if (!principal.email) return send(res, 400, { error: 'Sign in with your own account to send a test to yourself.' });
          await sendEmail(settings.mail, { to: principal.email, ...testMessage({ name: principal.name, serverName: settings.mail?.serverName ?? '', link: appUrl() }) }, { fetchImpl, keyring });
          const next = { ...settings, mail: { ...settings.mail, lastTestAt: clock() } };
          await store.save(next);
          await logAdmin('mail', `Test email sent to ${principal.email}`, []);
          return send(res, 200, { ...publicMail(next.mail), sentTo: principal.email });
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      // Everything below works on one site.
      const wanted = url.searchParams.get('site');
      const site = wanted ? findSite(settings, wanted) : visibleSites(principal, settings).find((x) => siteLive(settings, x));
      if (wanted && (!site || !canSeeSite(principal, site, settings))) return send(res, 404, { error: `Site ${wanted} not found, or not one of yours.` });
      if (!site) return send(res, 403, { error: 'Your account has no sites yet. Ask an admin to give you one.' });
      const app = liveApp(site);

      if (path === '/api/settings') {
        if (!canManageSite(principal, site)) return send(res, 403, { error: 'Only an admin, or a client admin for this site, can view or change its settings.' });
        const view = siteView(settings, site.id);
        const withSite = (s, v) => ({ site: publicSite(findSite(s, site.id), s), ...publicSettings(v, origin, { keyring }) });
        if (method === 'GET') return send(res, 200, withSite(settings, view));
        if (method === 'PUT') {
          const patch = await readBody(req);
          if (patch.rotateEncryptionKey) {
            // One key covers every site and the email token, so only an admin
            // can replace it. The
            // new key is stored alongside the old, then the re-encrypted
            // settings, then the old key is dropped: the secrets stay
            // readable if this stops part way.
            if (principal.role !== 'admin') return send(res, 403, { error: 'Only an admin can replace the encryption key, because it covers every site.' });
            const r = rotateEncryptionKey(settings, keyring, clock());
            await saveKeyring(redis, r.keyring);
            await store.save(r.settings);
            keyring = pruneKeyring(r.keyring);
            await saveKeyring(redis, keyring);
            await logAdmin('settings', `Encryption key replaced; ${r.count} saved secret(s) re-encrypted`, []);
            return send(res, 200, { ...withSite(r.settings, siteView(r.settings, site.id)), changed: ['encryption key'] });
          }
          const { settings: nextView, changed } = await applySettingsChange(view, patch, { keyring });
          await applyPostmark({ patch, prev: view, next: nextView, changed, origin, clock, fetchImpl, keyring });
          const next = putSiteView(settings, site.id, nextView);
          await store.save(next);
          if (changed.length) {
            await app.activity.add('settings', `Settings changed by ${signedIn.name}: ${changed.join(', ')}`, { by: signedIn });
            await logAdmin('settings', `${site.name}: settings changed: ${changed.join(', ')}`, [site.clientId]);
          }
          const body = { ...withSite(next, nextView), changed };
          return send(res, 200, body);
        }
        return send(res, 405, { error: 'method not allowed' });
      }

      if (method !== 'GET' && !canAct(principal)) return send(res, 403, { error: 'Your account can view this site but not change anything.' });
      const result = await route(app, method, url, () => readBody(req), signedIn);
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

const clientsOf = (settings, u) => [...new Set([...(u.clients ?? []), ...u.sites.map((id) => findSite(settings, id)?.clientId).filter(Boolean)])];

// The Admin panel's first tab: counts, and a to-do list of what is not yet
// set up or has gone stale, limited to what this user manages.
async function overview({ settings, principal, isAdmin, audit, clock }) {
  const sites = settings.sites.filter((x) => canManageSite(principal, x));
  const users = settings.users.filter((u) => canManageUser(principal, u, settings));
  const clients = managedClients(principal, settings);
  const now = Date.parse(`${clock()}:00Z`);
  const attention = [];
  if (isAdmin && !settings.mail?.serverToken) {
    attention.push({ level: 'bad', text: 'Email sending is not set up, so invites and password resets cannot be sent.', action: { type: 'email', label: 'Set up email' } });
  }
  const admins = activeAdmins(settings);
  if (isAdmin && admins.length === 1) {
    attention.push({ level: 'warn', text: `${admins[0].name} is the only active admin. Add a second so the install never depends on one person.`, action: { type: 'users', label: 'Add an admin' } });
  }
  for (const x of sites.filter((y) => siteLive(settings, y))) {
    const client = findClient(settings, x.clientId)?.name ?? '';
    if (!x.postmark) attention.push({ level: 'bad', text: `${client} / ${x.name}: Postmark is not connected, so OpenTable emails are not reaching Table Runner.`, action: { type: 'site', site: x.id, label: 'Open settings' } });
    if (x.floorPlan?.example) attention.push({ level: 'warn', text: `${client} / ${x.name}: still on the example floor plan.`, action: { type: 'site', site: x.id, label: 'Open settings' } });
  }
  for (const u of users.filter((y) => y.active && !y.passwordHash)) {
    const expired = u.invitedAt && now - Date.parse(`${u.invitedAt}:00Z`) > LINK_TTL_S.invite * 1000;
    attention.push({
      level: expired ? 'warn' : 'info',
      text: expired ? `${u.name}'s invite expired before they set a password.` : `${u.name} has not accepted their invite yet (sent ${u.invitedAt?.replace('T', ' ') ?? 'earlier'}).`,
      action: { type: 'resend', id: u.id, label: 'Send a new invite' },
    });
  }
  const log = await audit.list({ limit: 200 });
  const recent = (isAdmin ? log : log.filter((e) => (e.detail?.clients ?? []).some((c) => principal.clients.includes(c)))).slice(0, 8);
  return {
    scope: isAdmin ? 'Every client' : clients.map((c) => c.name).join(', '),
    counts: {
      clients: clients.length,
      sites: sites.length,
      liveSites: sites.filter((x) => siteLive(settings, x)).length,
      users: users.filter((u) => u.active).length,
      invited: users.filter((u) => u.active && !u.passwordHash).length,
      disabled: users.filter((u) => !u.active).length,
      admins: isAdmin ? admins.length : null,
    },
    mail: isAdmin ? publicMail(settings.mail) : { connected: Boolean(settings.mail?.serverToken) },
    attention,
    recent,
  };
}

function meFor(p) {
  return { kind: p.kind, name: p.name, email: p.email ?? null, role: p.role, canAct: canAct(p), isAdmin: p.role === 'admin', canManage: canManage(p) };
}

// Connects Postmark when a token is given, and keeps it pointed at the
// current webhook key when the key is regenerated. Runs before anything is
// saved, so a Postmark failure leaves the settings unchanged.
async function applyPostmark({ patch, prev, next, changed, origin, clock, fetchImpl, keyring }) {
  if (patch.disconnectPostmark && next.postmark) {
    delete next.postmark;
    changed.push('Postmark disconnected');
    return;
  }
  const newToken = typeof patch.postmarkServerToken === 'string' ? patch.postmarkServerToken.trim() : '';
  const keyChanged = next.inboundSecret !== prev.inboundSecret;
  const saved = keyChanged && next.postmark?.serverToken
    ? readSecret(next.postmark.serverToken, keyring, POSTMARK_TOKEN_FIELD, 'Paste the Postmark Server API token again under OpenTable emails in, then try again.')
    : '';
  const token = newToken || saved;
  if (!token) return;

  const hookUrl = inboundUrlFor(next, origin);
  await assertPublic(origin, fetchImpl);
  const server = await connectPostmark({ token, hookUrl, fetchImpl });
  next.postmark = { serverToken: encryptSecret(token, keyring, POSTMARK_TOKEN_FIELD), ...server, hookUrl, connectedAt: clock() };
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
