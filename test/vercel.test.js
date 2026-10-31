import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis } from './fake-redis.js';
import { createHandler } from '../src/vercel.js';
import { redisFromEnv } from '../src/live.js';

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
    const r = await call('POST', '/api/setup', { body: { code: setupCode(), teamPassword: TEAM, adminPassword: ADMIN } });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().token;
  }
  return { redis, call, logs, setupCode, setUp };
}

test('a fresh install needs the setup code from the logs', async () => {
  const { call, logs, setupCode } = harness();
  assert.deepEqual((await call('GET', '/api/health')).json(), { ok: true, setUp: false });
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: true });
  assert.match(logs[0], /^Table Runner setup code: /);

  assert.equal((await call('GET', '/api/status')).statusCode, 503);
  const wrong = await call('POST', '/api/setup', { body: { code: 'guess', teamPassword: TEAM, adminPassword: ADMIN } });
  assert.equal(wrong.statusCode, 403);
  const weak = await call('POST', '/api/setup', { body: { code: setupCode(), teamPassword: 'short', adminPassword: ADMIN } });
  assert.equal(weak.statusCode, 400);

  const ok = await call('POST', '/api/setup', { body: { code: setupCode(), teamPassword: TEAM, adminPassword: ADMIN } });
  assert.equal(ok.json().role, 'admin');
  // The code is single use.
  assert.equal((await call('POST', '/api/setup', { body: { code: setupCode(), teamPassword: TEAM, adminPassword: ADMIN } })).statusCode, 409);
  assert.deepEqual((await call('GET', '/api/setup-status')).json(), { needsSetup: false });
});

test('team and admin sign in; only admin sees settings; no secrets leak', async () => {
  const { call, setUp, redis } = harness();
  await setUp();
  assert.equal((await call('GET', '/api/status')).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { body: { password: 'nope' } })).statusCode, 401);

  const team = (await call('POST', '/api/login', { body: { password: TEAM } })).json();
  assert.equal(team.role, 'team');
  const status = await call('GET', '/api/index?route=status', { token: team.token });
  assert.equal(status.json().role, 'team');
  assert.equal(status.json().venueName, 'Broadcaster');
  assert.equal((await call('GET', '/api/settings', { token: team.token })).statusCode, 403);

  const admin = (await call('POST', '/api/login', { body: { password: ADMIN } })).json();
  const settings = (await call('GET', '/api/settings', { token: admin.token })).json();
  assert.match(settings.inboundUrl, /^https:\/\/tr\.example\/api\/inbound-email\?key=.{20,}$/);
  assert.equal(JSON.stringify(settings).includes('Hash'), false);

  // Stored passwords are hashes, never plain text.
  const raw = await redis.cmd('GET', 'tr:settings');
  assert.equal(raw.includes(TEAM) || raw.includes(ADMIN), false);

  await call('POST', '/api/logout', { token: team.token });
  assert.equal((await call('GET', '/api/status', { token: team.token })).statusCode, 401);
});

test('sign-in is limited to 10 failures per address', async () => {
  const { call, setUp } = harness();
  await setUp();
  const headers = { 'x-forwarded-for': '203.0.113.9' };
  for (let i = 0; i < 10; i++) await call('POST', '/api/login', { body: { password: 'x' }, headers });
  assert.equal((await call('POST', '/api/login', { body: { password: TEAM }, headers })).statusCode, 429);
  assert.equal((await call('POST', '/api/login', { body: { password: TEAM }, headers: { 'x-forwarded-for': '198.51.100.1' } })).statusCode, 200);
});

test('settings validate, log changes and refuse live SevenRooms until it exists', async () => {
  const { call, setUp } = harness();
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

  const status = (await call('GET', '/api/status', { token })).json();
  assert.equal(status.mode.floorPlan.live, true);
  const activity = (await call('GET', '/api/activity', { token })).json();
  assert.match(activity[0].message, /^Settings changed: alert webhook/);
  assert.equal(JSON.stringify(activity).includes('s3cret'), false);
});

test('changing a password signs everyone else out', async () => {
  const { call, setUp } = harness();
  const admin = await setUp();
  const team = (await call('POST', '/api/login', { body: { password: TEAM } })).json().token;
  const r = await call('PUT', '/api/settings', { token: admin, body: { teamPassword: 'new-team-password' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call('GET', '/api/status', { token: team })).statusCode, 401);
  assert.equal((await call('GET', '/api/status', { token: r.json().token })).statusCode, 200);
  assert.equal((await call('POST', '/api/login', { body: { password: 'new-team-password' } })).json().role, 'team');
  const same = await call('PUT', '/api/settings', { token: r.json().token, body: { teamPassword: ADMIN } });
  assert.equal(same.statusCode, 400);
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
  const { call, setUp } = harness({ fetchImpl: pm.fetchImpl });
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
