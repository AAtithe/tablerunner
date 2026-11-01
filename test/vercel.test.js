import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis, dumpRedis } from './fake-redis.js';
import { createHandler } from '../src/vercel.js';
import { redisFromEnv } from '../src/live.js';

const clock = () => '2026-11-04T10:00';
const ADMIN = { name: 'Tom Admin', email: 'admin@ws.co', password: 'admin-password-1' };
const VIEWER = { name: 'Host', email: 'host@venue.co', password: 'viewer-pass-1' };

function res() {
  const r = { statusCode: 0, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b; };
  r.json = () => JSON.parse(r.body);
  return r;
}

function harness({ fetchImpl } = {}) {
  const redis = new FakeRedis();
  const logs = [];
  const h = createHandler({ getRedis: () => redis, clock, log: (m) => logs.push(m), fetchImpl });
  const call = async (method, url, { body, token, headers = {} } = {}) => {
    const r = res();
    await h({ method, url, body, headers: { host: 'tr.example', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, r);
    return r;
  };
  const setupCode = () => logs.at(-1).split(': ')[1];
  async function setUp() {
    await call('GET', '/api/setup-status');
    const r = await call('POST', '/api/setup', { body: { code: setupCode(), ...ADMIN } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().token;
  }
  const login = (u) => call('POST', '/api/login', { body: { email: u.email, password: u.password } });
  return { redis, call, logs, setupCode, setUp, login };
}

test('a fresh install needs the setup code from the logs and creates a named admin', async () => {
  const { call, logs, setupCode, login } = harness();
  assert.deepEqual((await call('GET', '/api/health')).json(), { ok: true, setUp: false });
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: true, oldAdminPassword: false });
  assert.match(logs[0], /^Table Runner setup code: /);

  assert.equal((await call('GET', '/api/status')).statusCode, 503);
  const wrong = await call('POST', '/api/setup', { body: { code: 'guess', ...ADMIN } });
  assert.equal(wrong.statusCode, 403);
  const weak = await call('POST', '/api/setup', { body: { code: setupCode(), ...ADMIN, password: 'short' } });
  assert.equal(weak.statusCode, 400);

  const ok = await call('POST', '/api/setup', { body: { code: setupCode(), ...ADMIN } });
  assert.equal(ok.json().role, 'admin');
  // The code is single use.
  assert.equal((await call('POST', '/api/setup', { body: { code: setupCode(), ...ADMIN } })).statusCode, 409);
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: false, oldAdminPassword: false });
  const me = (await call('GET', '/api/me', { token: ok.json().token })).json();
  assert.equal(me.email, 'admin@ws.co');
  assert.equal((await login(ADMIN)).statusCode, 200);
});

test('named users sign in; only admin sees settings; no secrets leak; no shared passwords', async () => {
  const { call, setUp, redis, login } = harness();
  const token = await setUp();
  await call('POST', '/api/users', { token, body: { ...VIEWER, role: 'viewer', clients: ['client-1'] } });
  assert.equal((await call('GET', '/api/status')).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { body: { password: ADMIN.password } })).statusCode, 401);

  const viewer = (await login(VIEWER)).json();
  assert.equal(viewer.role, 'viewer');
  const status = await call('GET', '/api/index?route=status', { token: viewer.token });
  assert.equal(status.json().role, 'viewer');
  assert.equal(status.json().venueName, 'Broadcaster');
  assert.equal((await call('GET', '/api/settings', { token: viewer.token })).statusCode, 403);

  const admin = (await login(ADMIN)).json();
  const settings = (await call('GET', '/api/settings', { token: admin.token })).json();
  assert.match(settings.inboundUrl, /^https:\/\/tr\.example\/api\/inbound-email\?key=.{20,}$/);
  assert.equal(JSON.stringify(settings).includes('Hash'), false);
  assert.match((await call('PUT', '/api/settings', { token: admin.token, body: { teamPassword: 'new-team-password' } })).json().error, /retired/);

  // Stored passwords are hashes, never plain text.
  const raw = await redis.cmd('GET', 'tr:settings');
  assert.equal(raw.includes(ADMIN.password) || raw.includes(VIEWER.password), false);

  await call('POST', '/api/logout', { token: viewer.token });
  assert.equal((await call('GET', '/api/status', { token: viewer.token })).statusCode, 401);
});

test('sign-in is limited to 10 failures per address', async () => {
  const { call, setUp } = harness();
  await setUp();
  const headers = { 'x-forwarded-for': '203.0.113.9' };
  const body = { email: ADMIN.email, password: ADMIN.password };
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { body: { email: ADMIN.email, password: 'x' }, headers });
  assert.equal((await call('POST', '/api/login', { body, headers })).statusCode, 429);
  assert.equal((await call('POST', '/api/login', { body, headers: { 'x-forwarded-for': '198.51.100.1' } })).statusCode, 200);
});

test('settings validate, log changes and refuse live SevenRooms until it exists', async () => {
  const { call, setUp, redis } = harness();
  const token = await setUp();

  const bad = await call('PUT', '/api/settings', { token, body: { alertWebhookUrl: 'http://insecure' } });
  assert.equal(bad.statusCode, 400);

  const live = await call('PUT', '/api/settings', { token, body: { sevenRooms: { mode: 'live' } } });
  assert.equal(live.statusCode, 400);
  assert.match(live.json().error, /still being built/);

  const plan = (await call('GET', '/api/settings', { token })).json().floorPlan;
  const broken = { ...plan, openTable: { default: { late: ['T99'] } } };
  const fp = await call('PUT', '/api/settings', { token, body: { floorPlan: broken } });
  assert.equal(fp.statusCode, 400);
  assert.match(fp.json().error, /unknown table T99/);
  assert.match((await call('PUT', '/api/settings', { token, body: { floorPlan: { ...plan, venue: 'other' } } })).json().error, /cannot change/);

  const real = { ...plan, example: false, tables: { ...plan.tables, T30: { seats: 8 } } };
  const ok = await call('PUT', '/api/settings', {
    token, body: { floorPlan: real, alertWebhookUrl: 'https://hooks.example/abc', sevenRooms: { clientId: 'cid', clientSecret: 's3cret', venueId: 'v1' } },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().changed, ['alert webhook', 'SevenRooms client ID', 'SevenRooms venue ID', 'SevenRooms client secret', 'floor plan']);
  assert.equal(ok.json().sevenRooms.clientSecretSet, true);
  assert.equal(JSON.stringify(ok.json()).includes('s3cret'), false);
  assert.equal(ok.json().sevenRooms.clientSecretProblem, null);
  assert.equal(JSON.stringify([...redis.data.values()].map(String)).includes('s3cret'), false, 'never stored in plain text');

  const status = (await call('GET', '/api/status', { token })).json();
  assert.equal(status.mode.floorPlan.live, true);
  const activity = (await call('GET', '/api/activity', { token })).json();
  assert.match(activity[0].message, /^Settings changed: alert webhook/);
  assert.equal(JSON.stringify(activity).includes('s3cret'), false);
});

test('an install from before named users: team password retired, old admin password works until a named admin exists', async () => {
  const { call, redis, login } = harness();
  const { hashPassword } = await import('../src/settings.js');
  const { exampleConfig } = await import('../config/allocation.example.js');
  await redis.cmd('SET', 'tr:settings', JSON.stringify({
    teamPasswordHash: await hashPassword('old-team-password'),
    adminPasswordHash: await hashPassword('old-admin-password'),
    sessionEpoch: 3, inboundSecret: 'k'.repeat(32), alertWebhookUrl: '',
    sevenRooms: { mode: 'shadow', clientId: '', clientSecret: '', venueId: '' }, floorPlan: exampleConfig,
  }));
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: false, oldAdminPassword: true });
  // The team password is gone from storage and refused.
  assert.equal(JSON.parse(await redis.cmd('GET', 'tr:settings')).teamPasswordHash, undefined);
  assert.equal((await call('POST', '/api/login', { body: { password: 'old-team-password' } })).statusCode, 401);

  const old = (await call('POST', '/api/login', { body: { password: 'old-admin-password' } })).json();
  assert.equal(old.legacy, true);
  const status = (await call('GET', '/api/status', { token: old.token })).json();
  assert.equal(status.user.kind, 'legacy');
  // Bookings keep flowing on the same webhook key throughout.
  const email = { Subject: 'New reservation', TextBody: 'Confirmation #: OT4242\nGuest name: Sample Guest\nParty size: 2\nDate: 2026-11-06\nTime: 19:30' };
  assert.equal((await call('POST', `/api/inbound-email?key=${'k'.repeat(32)}`, { body: email })).json().action, 'created');

  const r = await call('POST', '/api/users', { token: old.token, body: { ...ADMIN, role: 'admin' } });
  assert.equal(r.statusCode, 200, r.body);
  // From now on the old admin password is refused, its sessions end, and its hash is deleted.
  assert.equal((await call('GET', '/api/status', { token: old.token })).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { body: { password: 'old-admin-password' } })).statusCode, 401);
  assert.equal(JSON.parse(await redis.cmd('GET', 'tr:settings')).adminPasswordHash, undefined);
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: false, oldAdminPassword: false });
  const admin = (await login(ADMIN)).json();
  assert.equal((await call('GET', '/api/day?date=2026-11-06', { token: admin.token })).json().sold, 1);
});

test('admins can remove other admins but never leave the install without one', async () => {
  const { call, setUp } = harness();
  const token = await setUp();
  const id = (await call('GET', '/api/users', { token })).json().users[0].id;
  const other = (await call('POST', '/api/users', { token, body: { name: 'Second', email: 'two@ws.co', password: 'second-admin-1', role: 'admin' } })).json();
  const t2 = (await call('POST', '/api/login', { body: { email: 'two@ws.co', password: 'second-admin-1' } })).json().token;
  assert.equal((await call('DELETE', `/api/users/${other.id}`, { token })).statusCode, 200);
  assert.equal((await call('GET', '/api/status', { token: t2 })).statusCode, 401);
  // The one admin left cannot disable, demote or delete themselves.
  assert.equal((await call('PUT', `/api/users/${id}`, { token, body: { active: false } })).statusCode, 400);
  assert.equal((await call('PUT', `/api/users/${id}`, { token, body: { role: 'viewer', clients: ['client-1'] } })).statusCode, 400);
  assert.equal((await call('DELETE', `/api/users/${id}`, { token })).statusCode, 400);
});

test('inbound email uses the key from settings; regenerating revokes the old one', async () => {
  const { call, setUp } = harness();
  const token = await setUp();
  const { inboundUrl } = (await call('GET', '/api/settings', { token })).json();
  const path = inboundUrl.replace('https://tr.example', '');
  const body = { Subject: 'New reservation', TextBody: 'Confirmation #: OT4242\nGuest name: Sample Guest\nParty size: 2\nDate: 2026-11-06\nTime: 19:30' };

  assert.equal((await call('POST', '/api/inbound-email?key=wrong', { body })).statusCode, 401);
  const ok = await call('POST', path, { body });
  assert.equal(ok.json().action, 'created');

  await call('PUT', '/api/settings', { token, body: { regenerateInboundSecret: true } });
  assert.equal((await call('POST', path, { body })).statusCode, 401);
});

test('scheduled jobs run without a secret and reconciliation is rate-limited', async () => {
  const { call, setUp } = harness();
  await setUp();
  assert.equal((await call('GET', '/api/cron/release')).statusCode, 200);
  const first = (await call('GET', '/api/cron/reconcile')).json();
  assert.equal(first.sites[0].site, 'broadcaster');
  assert.equal(first.sites[0].result.checked, 0);
  assert.equal((await call('GET', '/api/index?route=cron/reconcile')).json().sites[0].result.skipped, 'ran in the last 10 minutes');
});

test('missing storage connection is reported plainly', async () => {
  assert.throws(() => redisFromEnv({}), /connect a Redis database/);
  const h = createHandler({ getRedis: () => redisFromEnv({}) });
  const r = res();
  await h({ method: 'GET', url: '/api/health', headers: {} }, r);
  assert.equal(r.statusCode, 503);
  const s = res();
  await h({ method: 'GET', url: '/api/setup-status', headers: {} }, s);
  assert.match(s.json().error, /connect a Redis database/);
});

test('storage lookup picks REST, then a direct connection, and explains failures', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: 'PONG' }) });
  const rest = redisFromEnv({ STORAGE_KV_REST_API_URL: 'https://x.upstash.io', STORAGE_KV_REST_API_TOKEN: 't', REDIS_URL: 'redis://h:6379' }, { fetchImpl });
  assert.equal(rest.url, 'https://x.upstash.io');
  const tcp = redisFromEnv({ REDIS_URL: 'redis://default:secret@host:6379' });
  assert.equal(tcp.constructor.name, 'RedisTcp');
  assert.equal(redisFromEnv({ REDIS_URL: 'redis://default:secret@host:6379' }), tcp, 'connection is reused');
  assert.equal(redisFromEnv({ STORAGE_REDIS_URL: 'rediss://h:6380' }).constructor.name, 'RedisTcp');
  assert.throws(() => redisFromEnv({ KV_REST_API_URL: 'https://x' }), (e) => /found: KV_REST_API_URL, but none is a usable connection/.test(e.message));
  assert.throws(() => redisFromEnv({ REDIS_URL: 'not-a-url-secret' }), (e) => /found: REDIS_URL/.test(e.message) && !e.message.includes('secret'));
  assert.throws(() => redisFromEnv({ PATH: '/bin' }), /No storage settings were found/);
});

test('the client secret survives a key rotation and the old key is deleted', async () => {
  const { call, setUp, redis } = harness();
  const token = await setUp();
  await call('PUT', '/api/settings', { token, body: { sevenRooms: { clientSecret: 's3cret' } } });
  const before = JSON.parse(await redis.cmd('GET', 'tr:keyring'));

  const r = await call('PUT', '/api/settings', { token, body: { rotateEncryptionKey: true } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().changed, ['encryption key']);
  assert.equal(r.json().sevenRooms.clientSecretProblem, null);

  const after = JSON.parse(await redis.cmd('GET', 'tr:keyring'));
  assert.notEqual(after.current, before.current);
  assert.deepEqual(Object.keys(after.keys), [after.current], 'old key deleted');
  const stored = JSON.parse(await redis.cmd('GET', 'tr:settings')).sites[0].sevenRooms.clientSecret;
  assert.equal(stored.split('.')[1], after.current, 're-encrypted under the new key');
});

// Simulated Postmark Server API plus our own public health check.
function fakePostmark({ token = 'pm-token', protectedSite = false } = {}) {
  const server = { Name: 'Broadcaster inbound', InboundAddress: 'abc123@inbound.postmarkapp.com', InboundHookUrl: '' };
  const calls = [];
  const state = { revoked: false };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (url.endsWith('/api/health')) return { status: protectedSite ? 302 : 200, ok: !protectedSite };
    if (state.revoked || init.headers['x-postmark-server-token'] !== token) return { status: 401, ok: false, json: async () => ({}) };
    if ((init.method ?? 'GET') === 'PUT') Object.assign(server, JSON.parse(init.body));
    return { status: 200, ok: true, json: async () => ({ ...server }) };
  };
  return { fetchImpl, calls, server, state };
}

test('connecting Postmark points its webhook here and shows the forwarding address', async () => {
  const pm = fakePostmark();
  const { call, setUp, redis } = harness({ fetchImpl: pm.fetchImpl });
  const token = await setUp();

  const bad = await call('PUT', '/api/settings', { token, body: { postmarkServerToken: 'wrong' } });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /did not accept that token/);
  assert.equal((await call('GET', '/api/settings', { token })).json().postmark.connected, false);

  const ok = await call('PUT', '/api/settings', { token, body: { postmarkServerToken: 'pm-token' } });
  assert.equal(ok.statusCode, 200, ok.body);
  const s = ok.json();
  assert.deepEqual(s.changed, ['Postmark connected']);
  assert.equal(s.postmark.inboundAddress, 'abc123@inbound.postmarkapp.com');
  assert.equal(s.postmark.pointsHere, true);
  assert.equal(pm.server.InboundHookUrl, s.inboundUrl);
  assert.equal(JSON.stringify(s).includes('pm-token'), false);
  assert.equal(dumpRedis(redis).includes('pm-token'), false, 'never stored in plain text');

  // Regenerating the key re-points Postmark, so emails keep flowing.
  const regen = (await call('PUT', '/api/settings', { token, body: { regenerateInboundSecret: true } })).json();
  assert.deepEqual(regen.changed, ['email webhook key', 'Postmark webhook updated']);
  assert.equal(pm.server.InboundHookUrl, regen.inboundUrl);
  assert.notEqual(regen.inboundUrl, s.inboundUrl);

  const off = (await call('PUT', '/api/settings', { token, body: { disconnectPostmark: true } })).json();
  assert.equal(off.postmark.connected, false);
});

test('Postmark is refused from an address behind the Vercel login, and nothing changes', async () => {
  const pm = fakePostmark({ protectedSite: true });
  const { call, setUp } = harness({ fetchImpl: pm.fetchImpl });
  const token = await setUp();
  const before = (await call('GET', '/api/settings', { token })).json().inboundUrl;
  const r = await call('PUT', '/api/settings', { token, body: { postmarkServerToken: 'pm-token' } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /behind Vercel's login/);
  assert.equal(pm.calls.some((c) => c.url.includes('postmarkapp')), false);
  assert.equal((await call('GET', '/api/settings', { token })).json().inboundUrl, before);
});

test('if Postmark fails during a key change, the old key stays in force', async () => {
  const pm = fakePostmark();
  const { call, setUp } = harness({ fetchImpl: pm.fetchImpl });
  const token = await setUp();
  await call('PUT', '/api/settings', { token, body: { postmarkServerToken: 'pm-token' } });
  const before = (await call('GET', '/api/settings', { token })).json().inboundUrl;

  pm.state.revoked = true;
  const r = await call('PUT', '/api/settings', { token, body: { regenerateInboundSecret: true } });
  assert.equal(r.statusCode, 400);
  assert.equal((await call('GET', '/api/settings', { token })).json().inboundUrl, before);
  assert.equal(pm.server.InboundHookUrl, before);
});

test('a Postmark inbound token saved in plain text is encrypted and still re-points the webhook', async () => {
  const pm = fakePostmark();
  const { call, setUp, redis } = harness({ fetchImpl: pm.fetchImpl });
  const token = await setUp();
  await call('PUT', '/api/settings', { token, body: { postmarkServerToken: 'pm-token' } });

  const saved = JSON.parse(await redis.cmd('GET', 'tr:settings'));
  saved.sites[0].postmark.serverToken = 'pm-token';
  await redis.cmd('SET', 'tr:settings', JSON.stringify(saved));

  await call('PUT', '/api/settings', { token, body: { rotateEncryptionKey: true } });
  assert.equal(dumpRedis(redis).includes('pm-token'), false);
  // The admin log records the conversion once, with a count and no value.
  const log = (await call('GET', '/api/audit', { token })).json().map((e) => e.message);
  assert.deepEqual(log.filter((m) => /plain text/.test(m)), ['1 saved secret(s) found in plain text and encrypted at rest']);
  const regen = (await call('PUT', '/api/settings', { token, body: { regenerateInboundSecret: true } })).json();
  assert.deepEqual(regen.changed, ['email webhook key', 'Postmark webhook updated']);
  assert.equal(pm.server.InboundHookUrl, regen.inboundUrl);
});
