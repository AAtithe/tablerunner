import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis } from './fake-redis.js';
import { createApp } from '../src/app.js';
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


test('live mode with an unreadable client secret fails loudly, never silently shadows', async () => {
  const { SevenRoomsClient } = await import('../src/adapters/sevenrooms.js');
  const { encryptSecret, secretKeyFromEnv } = await import('../src/secrets.js');
  const key = secretKeyFromEnv({ TABLE_RUNNER_SECRET_KEY: 'a'.repeat(32) });
  const rotated = secretKeyFromEnv({ TABLE_RUNNER_SECRET_KEY: 'b'.repeat(32) });
  const settings = {
    floorPlan: config,
    sevenRooms: { mode: 'live', clientId: 'cid', venueId: 'v1', clientSecret: encryptSecret('s3cret', key, 'sevenRooms.clientSecret') },
  };
  const was = SevenRoomsClient.implemented;
  SevenRoomsClient.implemented = true;
  try {
    const ok = createLiveApp({ redis: new FakeRedis(), settings, clock, secretKey: key });
    assert.equal((await ok.status()).mode.sevenRooms.value, 'Live');

    const app = createLiveApp({ redis: new FakeRedis(), settings, clock, secretKey: rotated });
    const mode = (await app.status()).mode.sevenRooms;
    assert.equal(mode.value, 'Not connected');
    assert.equal(mode.detail.includes('s3cret'), false);
    const r = await app.ingestEmail(email(7));
    assert.equal(r.action, 'failed');
    assert.equal((await app.alerts.open())[0].code, 'sync_failed');
  } finally {
    SevenRoomsClient.implemented = was;
  }
});
