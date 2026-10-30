import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis } from './fake-redis.js';
import { createApp } from '../src/app.js';
import { createHandler } from '../src/vercel.js';
import { createLiveApp } from '../src/live.js';
import { exampleConfig as config } from '../config/allocation.example.js';
import {
  RedisStore, RedisLedger, RedisShadowSevenRooms, RedisAlerts, RedisActivity, RedisState, RedisLock, RedisRest,
} from '../src/adapters/redis.js';

const FRI = '2026-11-06';
const clock = () => '2026-11-04T10:00';

function redisApp(redis = new FakeRedis()) {
  const p = 'tr:test';
  const app = createApp({
    config, clock, mode: { demo: false },
    store: new RedisStore(redis, p),
    ledger: new RedisLedger(redis, p),
    sevenRooms: new RedisShadowSevenRooms(redis, p),
    alerts: new RedisAlerts(redis, p, { clock }),
    activity: new RedisActivity(redis, p, { clock }),
    state: new RedisState(redis, p),
    lock: new RedisLock(redis, p),
    manualRelease: true,
  });
  return { app, redis };
}

const email = (conf, party = 2, time = '19:30') => ({
  subject: 'New reservation',
  text: `Confirmation #: ${conf}000\nGuest name: Test Guest\nParty size: ${party}\nDate: ${FRI}\nTime: ${time}`,
});

test('redis-backed app syncs, persists and reports', async () => {
  const { app, redis } = redisApp();
  assert.equal((await app.ingestEmail(email('OT1'))).action, 'created');
  assert.equal((await app.ingestEmail(email('OT1'))).action, 'noop');

  // A second instance on the same database sees the same state.
  const { app: other } = redisApp(redis);
  const day = await other.dayView(FRI);
  assert.equal(day.sold, 1);
  assert.equal((await other.status()).lastEmailAt, '2026-11-04T10:00');
  assert.equal((await other.activity.list())[0].message.startsWith('Duplicate'), true);

  const rec = await other.reconcile();
  assert.equal(rec.issues.length, 0);
});

test('two instances booking at once never share a table', async () => {
  const redis = new FakeRedis();
  const a = redisApp(redis).app;
  const b = redisApp(redis).app;
  // Friday late has two 2-seat tables (T1, T2). Fire four bookings at once
  // from two "function instances".
  const results = await Promise.all([
    a.ingestEmail(email('OT1')), b.ingestEmail(email('OT2')),
    a.ingestEmail(email('OT3')), b.ingestEmail(email('OT4')),
  ]);
  const tables = results.filter((r) => r.action === 'created').map((r) => r.record.table);
  assert.equal(new Set(tables).size, tables.length, `duplicate table in ${tables}`);
  // 2 two-tops + 2 four-tops allocated on Friday late: all four fit, uniquely.
  assert.deepEqual(tables.sort(), ['T1', 'T10', 'T11', 'T2']);
});

test('without the lock the same race double-books, which is why it exists', async () => {
  const redis = new FakeRedis();
  const noLock = { run: (fn) => fn() };
  const make = () => createApp({
    config, clock, mode: {}, lock: noLock,
    store: new RedisStore(redis, 'x'), ledger: new RedisLedger(redis, 'x'),
    sevenRooms: new RedisShadowSevenRooms(redis, 'x'), alerts: new RedisAlerts(redis, 'x', { clock }),
    activity: new RedisActivity(redis, 'x', { clock }), state: new RedisState(redis, 'x'),
  });
  const results = await Promise.all([make().ingestEmail(email('OT1')), make().ingestEmail(email('OT2'))]);
  const tables = results.map((r) => r.record?.table);
  assert.equal(tables[0], tables[1]);
});

test('alerts acknowledge across instances', async () => {
  const { app, redis } = redisApp();
  await app.ingestEmail({ subject: 'New reservation', text: 'unreadable' });
  const [alert] = await app.alerts.open();
  assert.equal(alert.code, 'unparseable_email');
  await redisApp(redis).app.alerts.acknowledge(alert.id);
  assert.equal((await app.alerts.open()).length, 0);
});

test('RedisRest sends Upstash REST commands and surfaces errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    const cmd = JSON.parse(init.body);
    return { ok: cmd[0] !== 'BAD', status: 200, json: async () => (cmd[0] === 'BAD' ? { error: 'ERR unknown' } : { result: 'OK' }) };
  };
  const r = new RedisRest({ url: 'https://example.upstash.io/', token: 't', fetchImpl });
  assert.equal(await r.cmd('SET', 'k', 1), 'OK');
  assert.equal(seen[0].url, 'https://example.upstash.io');
  assert.equal(seen[0].init.headers.authorization, 'Bearer t');
  assert.deepEqual(JSON.parse(seen[0].init.body), ['SET', 'k', '1']);
  await assert.rejects(r.cmd('BAD'), /ERR unknown/);
});

// ---- Vercel handler

function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.end = (b) => { res.body = b; };
  res.json = () => JSON.parse(res.body);
  return res;
}

async function call(handler, { method = 'GET', url, headers = {}, body }) {
  const res = fakeRes();
  await handler({ method, url, headers, body }, res);
  return res;
}

const ENV = { DASHBOARD_PASSWORD: 'dash', INBOUND_SECRET: 'inbound', CRON_SECRET: 'cron' };

function handler(env = ENV) {
  const { app } = redisApp();
  return { app, h: createHandler(env, () => app) };
}

test('dashboard routes require the dashboard password', async () => {
  const { h } = handler();
  assert.equal((await call(h, { url: '/api/index?route=status' })).statusCode, 401);
  assert.equal((await call(h, { url: '/api/status', headers: { authorization: 'Bearer wrong' } })).statusCode, 401);
  const ok = await call(h, { url: '/api/index?route=status', headers: { authorization: 'Bearer dash' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().venueName, 'Broadcaster');
  // The inbound secret does not open the dashboard.
  assert.equal((await call(h, { url: '/api/status', headers: { authorization: 'Bearer inbound' } })).statusCode, 401);
});

test('routes fail closed when their secret is not configured', async () => {
  const { h } = handler({});
  assert.equal((await call(h, { url: '/api/status' })).statusCode, 503);
  assert.equal((await call(h, { url: '/api/cron/release' })).statusCode, 503);
  assert.equal((await call(h, { method: 'POST', url: '/api/inbound-email', body: {} })).statusCode, 503);
});

test('inbound email accepts a Postmark webhook with the key', async () => {
  const { h, app } = handler();
  const postmark = { Subject: 'New reservation', TextBody: email('OT77').text };
  assert.equal((await call(h, { method: 'POST', url: '/api/inbound-email?key=nope', body: postmark })).statusCode, 401);
  const res = await call(h, { method: 'POST', url: '/api/index?route=inbound-email&key=inbound', body: postmark });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().action, 'created');
  assert.equal((await app.dayView(FRI)).sold, 1);
});

test('cron routes need the Vercel cron secret', async () => {
  const { h } = handler();
  assert.equal((await call(h, { url: '/api/cron/reconcile' })).statusCode, 401);
  const res = await call(h, { url: '/api/cron/reconcile', headers: { authorization: 'Bearer cron' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().checked, 0);
  const rel = await call(h, { url: '/api/index?route=cron/release', headers: { authorization: 'Bearer cron' } });
  assert.equal(rel.statusCode, 200);
});

test('health reports missing storage without leaking detail', async () => {
  const h = createHandler(ENV, () => createLiveApp({}));
  const res = await call(h, { url: '/api/health' });
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.json(), { ok: false });
  const status = await call(h, { url: '/api/status', headers: { authorization: 'Bearer dash' } });
  assert.equal(status.statusCode, 503);
  assert.match(status.json().error, /Upstash Redis/);
});

test('live app runs end to end over the Upstash REST client, in shadow mode', async () => {
  const fake = new FakeRedis();
  const fetchImpl = async (url, init) => {
    const [name, ...args] = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ result: await fake.cmd(name, ...args) }) };
  };
  const app = createLiveApp({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }, { fetchImpl, clock });
  assert.equal((await app.ingestEmail(email('OT5'))).action, 'created');
  const status = await app.status();
  assert.equal(status.venueName, 'Broadcaster');
  assert.equal(status.mode.sevenRooms.value, 'Shadow');
  assert.equal(status.mode.emailParser.live, false);
  assert.equal(status.mode.floorPlan.live, false);
  assert.ok([...fake.data.keys()].some((k) => k === 'tr:broadcaster:shadow'));
});
