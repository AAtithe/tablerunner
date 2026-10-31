// Runs the live service against a real Redis server over a direct
// connection, when redis-server is installed. Skipped otherwise.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { RedisTcp } from '../src/adapters/redis-tcp.js';
import { createHandler } from '../src/vercel.js';

let hasServer = true;
try { execFileSync('redis-server', ['--version']); } catch { hasServer = false; }

let proc;
let url;

before(async () => {
  if (!hasServer) return;
  const port = await new Promise((resolve) => {
    const s = createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  url = `redis://127.0.0.1:${port}`;
  const probe = new RedisTcp(url);
  for (let i = 0; i < 50; i++) {
    try { await probe.cmd('PING'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  await probe.close();
});

after(() => proc?.kill());

const res = () => {
  const r = { statusCode: 0, body: '', setHeader() {} };
  r.end = (b) => { r.body = b; };
  r.json = () => JSON.parse(r.body);
  return r;
};

test('full live flow over a real Redis connection, two instances at once', { skip: !hasServer && 'redis-server not installed' }, async () => {
  const a = new RedisTcp(url);
  const b = new RedisTcp(url);
  const logs = [];
  const clock = () => '2026-11-04T10:00';
  const ha = createHandler({ getRedis: () => a, clock, log: (m) => logs.push(m) });
  const hb = createHandler({ getRedis: () => b, clock, log: () => {} });
  const call = async (h, method, path, { body, token } = {}) => {
    const r = res();
    await h({ method, url: path, body, headers: { host: 'tr.example', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, r);
    return r;
  };

  assert.deepEqual((await call(ha, 'GET', '/api/health')).json(), { ok: true, setUp: false });
  await call(ha, 'GET', '/api/setup-status');
  const code = logs.at(-1).split(': ')[1];
  const setup = await call(ha, 'POST', '/api/setup', { body: { code, teamPassword: 'team-password-1', adminPassword: 'admin-password-1' } });
  assert.equal(setup.statusCode, 200, setup.body);
  const token = setup.json().token;

  const { inboundUrl } = (await call(hb, 'GET', '/api/settings', { token })).json();
  const path = inboundUrl.replace('https://tr.example', '');
  const email = (n) => ({ Subject: 'New reservation', TextBody: `Confirmation #: OT${n}000\nGuest name: Test Guest\nParty size: 2\nDate: 2026-11-06\nTime: 19:30` });
  const results = await Promise.all([1, 2, 3, 4].map((n) => call(n % 2 ? ha : hb, 'POST', path, { body: email(n) })));
  const tables = results.map((r) => r.json().record?.table).sort();
  assert.deepEqual(tables, ['T1', 'T10', 'T11', 'T2']);

  const day = (await call(ha, 'GET', '/api/day?date=2026-11-06', { token })).json();
  assert.equal(day.sold, 4);
  assert.equal((await call(hb, 'GET', '/api/cron/reconcile')).json().sites[0].result.issues.length, 0);

  await a.close();
  await b.close();
});
