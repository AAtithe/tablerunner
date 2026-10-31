import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis } from './fake-redis.js';
import { createHandler } from '../src/vercel.js';

const clock = () => '2026-11-04T10:00';
const TEAM = 'team-password-1';
const ADMIN = 'admin-password-1';

function res() {
  const r = { statusCode: 0, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b; };
  r.json = () => JSON.parse(r.body);
  return r;
}

async function harness() {
  const redis = new FakeRedis();
  const logs = [];
  const h = createHandler({ getRedis: () => redis, clock, log: (m) => logs.push(m) });
  const call = async (method, url, { body, token, headers = {} } = {}) => {
    const r = res();
    await h({ method, url, body, headers: { host: 'tr.example', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, r);
    return r;
  };
  await call('GET', '/api/setup-status');
  const code = logs.at(-1).split(': ')[1];
  const admin = (await call('POST', '/api/setup', { body: { code, teamPassword: TEAM, adminPassword: ADMIN } })).json().token;
  const login = async (email, password) => call('POST', '/api/login', { body: { email, password } });
  return { redis, call, admin, login };
}

const email = (conf) => ({ Subject: 'New reservation', TextBody: `Confirmation #: ${conf}\nGuest name: Sample Guest\nParty size: 2\nDate: 2026-11-06\nTime: 19:30` });

test('existing single-venue settings become the first site', async () => {
  const { call, admin } = await harness();
  const { sites } = (await call('GET', '/api/sites', { token: admin })).json();
  assert.deepEqual(sites.map((s) => [s.id, s.name, s.active]), [['broadcaster', 'Broadcaster', true]]);
  assert.equal((await call('GET', '/api/status', { token: admin })).json().site, 'broadcaster');
});

test('admins add, rename and archive sites; each site keeps its own data and webhook', async () => {
  const { call, admin } = await harness();
  assert.equal((await call('POST', '/api/sites', { token: admin, body: { id: 'Bad Code!', name: 'X' } })).statusCode, 400);
  const added = await call('POST', '/api/sites', { token: admin, body: { id: 'soho', name: 'Soho' } });
  assert.equal(added.statusCode, 200, added.body);
  assert.equal(added.json().example, true);
  assert.equal((await call('POST', '/api/sites', { token: admin, body: { id: 'soho', name: 'Again' } })).statusCode, 400);

  const soho = (await call('GET', '/api/settings?site=soho', { token: admin })).json();
  const broadcaster = (await call('GET', '/api/settings', { token: admin })).json();
  assert.equal(soho.site.id, 'soho');
  assert.equal(soho.floorPlan.venue, 'soho');
  assert.notEqual(soho.inboundUrl, broadcaster.inboundUrl);

  // An email to Soho's address lands at Soho only.
  const r = await call('POST', soho.inboundUrl.replace('https://tr.example', ''), { body: email('OT1001') });
  assert.equal(r.json().action, 'created');
  assert.equal((await call('GET', '/api/day?date=2026-11-06&site=soho', { token: admin })).json().sold, 1);
  assert.equal((await call('GET', '/api/day?date=2026-11-06', { token: admin })).json().sold, 0);

  // Settings are per site.
  await call('PUT', '/api/settings?site=soho', { token: admin, body: { alertWebhookUrl: 'https://hooks.example/soho' } });
  assert.equal((await call('GET', '/api/settings', { token: admin })).json().alertWebhookUrl, '');
  assert.equal((await call('GET', '/api/settings?site=soho', { token: admin })).json().alertWebhookUrl, 'https://hooks.example/soho');

  const renamed = await call('PUT', '/api/sites/soho', { token: admin, body: { name: 'Soho Kitchen' } });
  assert.equal(renamed.json().name, 'Soho Kitchen');
  assert.equal((await call('GET', '/api/status?site=soho', { token: admin })).json().venueName, 'Soho Kitchen');
  assert.match((await call('PUT', '/api/sites/soho', { token: admin, body: { id: 'other' } })).json().error, /cannot change/);

  // Cron covers every active site; archived sites are skipped and their emails refused.
  assert.deepEqual((await call('GET', '/api/cron/release')).json().sites.map((s) => s.site), ['broadcaster', 'soho']);
  await call('PUT', '/api/sites/soho', { token: admin, body: { active: false } });
  assert.deepEqual((await call('GET', '/api/cron/release')).json().sites.map((s) => s.site), ['broadcaster']);
  assert.equal((await call('POST', soho.inboundUrl.replace('https://tr.example', ''), { body: email('OT1002') })).statusCode, 403);
  assert.match((await call('PUT', '/api/sites/broadcaster', { token: admin, body: { active: false } })).json().error, /At least one site/);

  const log = (await call('GET', '/api/audit', { token: admin })).json().map((a) => a.message);
  assert.ok(log.includes('Site Soho (soho) added'));
  assert.ok(log.some((m) => /archived/.test(m)));
});

test('named users sign in by email and see only their sites with their role', async () => {
  const { call, admin, login } = await harness();
  await call('POST', '/api/sites', { token: admin, body: { id: 'soho', name: 'Soho' } });

  const weak = await call('POST', '/api/users', { token: admin, body: { name: 'Gm', email: 'gm@venue.co', role: 'manager', sites: ['soho'], password: 'short' } });
  assert.equal(weak.statusCode, 400);
  const created = await call('POST', '/api/users', { token: admin, body: { name: 'Sam GM', email: 'GM@venue.co ', role: 'manager', sites: ['soho'], password: 'manager-pass-1' } });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().email, 'gm@venue.co');
  assert.equal(JSON.stringify(created.json()).includes('Hash'), false);
  assert.equal((await call('POST', '/api/users', { token: admin, body: { name: 'Dup', email: 'gm@venue.co', role: 'viewer', sites: ['soho'], password: 'viewer-pass-1' } })).statusCode, 400);
  await call('POST', '/api/users', { token: admin, body: { name: 'Host', email: 'host@venue.co', role: 'viewer', sites: ['broadcaster'], password: 'viewer-pass-1' } });

  assert.equal((await login('gm@venue.co', 'wrong-password')).statusCode, 401);
  assert.equal((await login('nobody@venue.co', 'manager-pass-1')).statusCode, 401);
  const gm = (await login('gm@venue.co', 'manager-pass-1')).json();
  assert.equal(gm.role, 'manager');

  // The manager sees Soho only, and defaults to it.
  const me = (await call('GET', '/api/me', { token: gm.token })).json();
  assert.deepEqual(me.sites.map((s) => s.id), ['soho']);
  assert.equal((await call('GET', '/api/status', { token: gm.token })).json().site, 'soho');
  assert.equal((await call('GET', '/api/status?site=broadcaster', { token: gm.token })).statusCode, 404);
  assert.equal((await call('POST', '/api/reconcile?site=soho', { token: gm.token })).statusCode, 200);
  for (const p of ['/api/users', '/api/settings', '/api/audit']) assert.equal((await call('GET', p, { token: gm.token })).statusCode, 403, p);
  assert.equal((await call('POST', '/api/sites', { token: gm.token, body: { id: 'x1', name: 'X' } })).statusCode, 403);

  // A viewer reads but cannot act.
  const host = (await login('host@venue.co', 'viewer-pass-1')).json();
  assert.equal((await call('GET', '/api/day', { token: host.token })).statusCode, 200);
  assert.equal((await call('POST', '/api/release', { token: host.token })).statusCode, 403);

  // The list shows last sign-in.
  const list = (await call('GET', '/api/users', { token: admin })).json();
  assert.equal(list.users.find((u) => u.email === 'gm@venue.co').lastSignInAt, '2026-11-04T10:00');
  assert.ok(list.roles.manager);
});

test('changing or disabling a user ends only that user\'s sessions', async () => {
  const { call, admin, login } = await harness();
  const a = (await call('POST', '/api/users', { token: admin, body: { name: 'A', email: 'a@venue.co', role: 'manager', sites: ['*'], password: 'a-password-1' } })).json();
  await call('POST', '/api/users', { token: admin, body: { name: 'B', email: 'b@venue.co', role: 'manager', sites: ['*'], password: 'b-password-1' } });
  const ta = (await login('a@venue.co', 'a-password-1')).json().token;
  const tb = (await login('b@venue.co', 'b-password-1')).json().token;

  await call('PUT', `/api/users/${a.id}`, { token: admin, body: { role: 'viewer' } });
  assert.equal((await call('GET', '/api/status', { token: ta })).statusCode, 401);
  assert.equal((await call('GET', '/api/status', { token: tb })).statusCode, 200);

  await call('PUT', `/api/users/${a.id}`, { token: admin, body: { active: false } });
  const disabled = await login('a@venue.co', 'a-password-1');
  assert.equal(disabled.statusCode, 401);
  assert.match(disabled.json().error, /disabled/);

  // Users change their own password and stay signed in on the new token.
  const bad = await call('PUT', '/api/me/password', { token: tb, body: { currentPassword: 'nope', newPassword: 'b-password-2' } });
  assert.equal(bad.statusCode, 400);
  const ok = (await call('PUT', '/api/me/password', { token: tb, body: { currentPassword: 'b-password-1', newPassword: 'b-password-2' } })).json();
  assert.equal((await call('GET', '/api/status', { token: tb })).statusCode, 401);
  assert.equal((await call('GET', '/api/status', { token: ok.token })).statusCode, 200);
  assert.equal((await login('b@venue.co', 'b-password-2')).statusCode, 200);

  await call('DELETE', `/api/users/${a.id}`, { token: admin });
  assert.equal((await call('GET', '/api/users', { token: admin })).json().users.length, 1);
});

test('an admin user cannot lock themselves out', async () => {
  const { call, admin, login } = await harness();
  const u = (await call('POST', '/api/users', { token: admin, body: { name: 'Owner', email: 'owner@ws.co', role: 'admin', sites: [], password: 'owner-pass-1' } })).json();
  assert.deepEqual(u.sites, ['*']);
  const t = (await login('owner@ws.co', 'owner-pass-1')).json().token;
  assert.match((await call('PUT', `/api/users/${u.id}`, { token: t, body: { active: false } })).json().error, /your own account/);
  assert.match((await call('PUT', `/api/users/${u.id}`, { token: t, body: { role: 'viewer', sites: ['*'] } })).json().error, /own admin role/);
  assert.match((await call('DELETE', `/api/users/${u.id}`, { token: t })).json().error, /your own account/);
  // Settings saved by a named admin keep them signed in after a shared password change.
  const r = (await call('PUT', '/api/settings', { token: t, body: { teamPassword: 'new-team-password' } })).json();
  assert.equal((await call('GET', '/api/me', { token: r.token })).json().email, 'owner@ws.co');
  assert.equal((await call('POST', '/api/login', { body: { password: TEAM } })).statusCode, 401);
});
