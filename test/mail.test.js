import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis, dumpRedis } from './fake-redis.js';
import { createHandler } from '../src/vercel.js';

let now = '2026-11-04T10:00';
const clock = () => now;
const ADMIN = { name: 'Tom Admin', email: 'admin@ws.co', password: 'admin-password-1' };

// Simulated Postmark: checks the server token, records every email sent.
function fakePostmark({ token = 'pm-send', reject } = {}) {
  const sent = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.headers?.['x-postmark-server-token'] !== token) return { status: 401, ok: false, json: async () => ({ ErrorCode: 10, Message: 'Bad token' }) };
    if (url.endsWith('/server')) return { status: 200, ok: true, json: async () => ({ Name: 'WS outbound' }) };
    if (url.endsWith('/email')) {
      const m = JSON.parse(init.body);
      if (reject) return { status: 422, ok: false, json: async () => reject };
      sent.push(m);
      return { status: 200, ok: true, json: async () => ({ ErrorCode: 0, MessageID: `m${sent.length}` }) };
    }
    return { status: 404, ok: false, json: async () => ({}) };
  };
  return { fetchImpl, sent };
}

function res() {
  const r = { statusCode: 0, headers: {}, body: '' };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b; };
  r.json = () => JSON.parse(r.body);
  return r;
}

async function harness(pm = fakePostmark()) {
  now = '2026-11-04T10:00';
  const redis = new FakeRedis();
  const logs = [];
  const h = createHandler({ getRedis: () => redis, clock, log: (m) => logs.push(m), fetchImpl: pm.fetchImpl });
  const call = async (method, url, { body, token, headers = {} } = {}) => {
    const r = res();
    await h({ method, url, body, headers: { host: 'tr.example', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } }, r);
    return r;
  };
  await call('GET', '/api/setup-status');
  const admin = (await call('POST', '/api/setup', { body: { code: logs.at(-1).split(': ')[1], ...ADMIN } })).json().token;
  const linkOf = (m) => m.TextBody.match(/\?link=([\w-]+)/)[1];
  return { redis, call, admin, pm, linkOf };
}

const connect = (call, admin) => call('PUT', '/api/mail', { token: admin, body: { serverToken: 'pm-send', from: 'TableRunner@WS.co', fromName: 'Table Runner' } });

test('email sending: connect, refuse a bad token, test, disconnect; the token never leaks', async () => {
  const { call, admin, pm } = await harness();
  assert.equal((await call('GET', '/api/mail', { token: admin })).json().connected, false);
  assert.equal((await call('PUT', '/api/mail', { token: admin, body: { serverToken: 'wrong', from: 'tr@ws.co' } })).statusCode, 400);
  assert.equal((await call('PUT', '/api/mail', { token: admin, body: { serverToken: 'pm-send', from: 'not-an-email' } })).statusCode, 400);

  const ok = await connect(call, admin);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().from, 'tablerunner@ws.co');
  assert.equal(ok.json().serverName, 'WS outbound');
  assert.equal(ok.json().appUrl, 'https://tr.example');
  assert.equal(JSON.stringify(ok.json()).includes('pm-send'), false);

  const t = await call('POST', '/api/mail/test', { token: admin });
  assert.equal(t.statusCode, 200, t.body);
  assert.equal(pm.sent[0].To, 'admin@ws.co');
  assert.equal(pm.sent[0].From, '"Table Runner" <tablerunner@ws.co>');
  assert.equal(pm.sent[0].MessageStream, 'outbound');

  const preview = (await call('GET', '/api/mail/preview?kind=invite', { token: admin })).json();
  assert.match(preview.html, /Set my password/);

  assert.equal((await call('PUT', '/api/mail', { token: admin, body: { disconnect: true } })).json().connected, false);
});

test('invite: the user sets their own password from a one-time link, then signs in', async () => {
  const { call, admin, pm, linkOf } = await harness();
  const body = { name: 'Sam Patel', email: 'sam@venue.co', role: 'manager', clients: ['client-1'], invite: true };
  assert.match((await call('POST', '/api/users', { token: admin, body })).json().error, /Email sending is not set up/);
  await connect(call, admin);

  const created = await call('POST', '/api/users', { token: admin, body });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().invited, true);
  const mail = pm.sent.at(-1);
  assert.equal(mail.To, 'sam@venue.co');
  assert.match(mail.TextBody, /Tom Admin has given you a Table Runner account/);
  assert.match(mail.TextBody, /Unassigned \(all sites\)/);
  const token = linkOf(mail);

  // Nobody can sign in to an invited account before the password is set.
  assert.equal((await call('POST', '/api/login', { body: { email: 'sam@venue.co', password: '' } })).statusCode, 401);

  assert.deepEqual((await call('GET', `/api/link?token=${token}`)).json(), { kind: 'invite', name: 'Sam Patel', email: 'sam@venue.co' });
  assert.equal((await call('POST', '/api/link/accept', { body: { token, password: 'short' } })).statusCode, 400);
  const accepted = await call('POST', '/api/link/accept', { body: { token, password: 'sam-password-1' } });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await call('GET', '/api/me', { token: accepted.json().token })).json().email, 'sam@venue.co');

  // The link is single use.
  assert.equal((await call('GET', `/api/link?token=${token}`)).statusCode, 410);
  assert.equal((await call('POST', '/api/link/accept', { body: { token, password: 'sam-password-2' } })).statusCode, 410);
  assert.equal((await call('POST', '/api/login', { body: { email: 'sam@venue.co', password: 'sam-password-1' } })).statusCode, 200);

  const log = (await call('GET', '/api/audit', { token: admin })).json().map((e) => e.message);
  assert.ok(log.includes('sam@venue.co accepted their invite'));
});

test('resending an invite voids the old link; a failed send saves nothing', async () => {
  const pm = fakePostmark();
  const { call, admin, linkOf } = await harness(pm);
  await connect(call, admin);
  const u = (await call('POST', '/api/users', { token: admin, body: { name: 'Jo', email: 'jo@venue.co', role: 'viewer', clients: ['client-1'], invite: true } })).json();
  const first = linkOf(pm.sent.at(-1));
  const again = await call('POST', `/api/users/${u.id}/link`, { token: admin });
  assert.equal(again.json().sent, 'invite');
  const second = linkOf(pm.sent.at(-1));
  assert.equal((await call('GET', `/api/link?token=${first}`)).statusCode, 410);
  assert.equal((await call('GET', `/api/link?token=${second}`)).statusCode, 200);

  // Changing the email voids links sent to the old address.
  await call('PUT', `/api/users/${u.id}`, { token: admin, body: { email: 'jo2@venue.co' } });
  assert.equal((await call('GET', `/api/link?token=${second}`)).statusCode, 410);
});

test('a Postmark refusal is explained and nothing is saved', async () => {
  const pm = fakePostmark({ reject: { ErrorCode: 400, Message: 'Sender signature not defined' } });
  const { call, admin } = await harness(pm);
  await connect(call, admin);
  const r = await call('POST', '/api/users', { token: admin, body: { name: 'Al', email: 'al@venue.co', role: 'viewer', clients: ['client-1'], invite: true } });
  assert.equal(r.statusCode, 502);
  assert.match(r.json().error, /Sender Signatures/);
  assert.equal((await call('GET', '/api/users', { token: admin })).json().users.length, 1);
});

test('forgotten password: same answer for everyone; the link resets and signs out other sessions', async () => {
  const { call, admin, pm, linkOf } = await harness();
  await connect(call, admin);
  const before = pm.sent.length;
  const none = await call('POST', '/api/password-reset', { body: { email: 'nobody@venue.co' } });
  const real = await call('POST', '/api/password-reset', { body: { email: 'admin@ws.co' } });
  assert.deepEqual(none.json(), real.json());
  assert.equal(pm.sent.length, before + 1);
  const token = linkOf(pm.sent.at(-1));
  assert.equal((await call('GET', `/api/link?token=${token}`)).json().kind, 'reset');
  const r = await call('POST', '/api/link/accept', { body: { token, password: 'new-admin-pass-1' } });
  assert.equal(r.statusCode, 200);
  assert.equal((await call('GET', '/api/status', { token: admin })).statusCode, 401);
  assert.equal((await call('POST', '/api/login', { body: { email: 'admin@ws.co', password: 'new-admin-pass-1' } })).statusCode, 200);
  assert.equal((await call('POST', '/api/login', { body: { email: 'admin@ws.co', password: ADMIN.password } })).statusCode, 401);
});

test('overview lists what needs attention, scoped to the user', async () => {
  const { call, admin } = await harness();
  let o = (await call('GET', '/api/admin/overview', { token: admin })).json();
  assert.equal(o.counts.sites, 1);
  assert.equal(o.counts.admins, 1);
  const texts = o.attention.map((a) => a.text).join(' | ');
  assert.match(texts, /Email sending is not set up/);
  assert.match(texts, /only active admin/);
  assert.match(texts, /Postmark is not connected/);
  assert.match(texts, /example floor plan/);

  await connect(call, admin);
  await call('POST', '/api/users', { token: admin, body: { name: 'Jo', email: 'jo@venue.co', role: 'viewer', clients: ['client-1'], invite: true } });
  now = '2026-11-20T10:00';
  o = (await call('GET', '/api/admin/overview', { token: admin })).json();
  assert.equal(o.counts.invited, 1);
  assert.ok(o.attention.some((a) => /invite expired/.test(a.text) && a.action.type === 'resend'));

  // A client admin sees only their own client, and no email settings.
  await call('POST', '/api/clients', { token: admin, body: { name: 'Other' } });
  await call('POST', '/api/users', { token: admin, body: { name: 'Ca', email: 'ca@x.co', role: 'client_admin', clients: ['other'], password: 'client-admin-1' } });
  const ca = (await call('POST', '/api/login', { body: { email: 'ca@x.co', password: 'client-admin-1' } })).json().token;
  o = (await call('GET', '/api/admin/overview', { token: ca })).json();
  assert.equal(o.scope, 'Other');
  assert.equal(o.counts.sites, 0);
  assert.equal(o.mail.from, undefined);
  assert.equal((await call('GET', '/api/mail', { token: ca })).statusCode, 403);
});

test('the sending token is stored encrypted, survives a key rotation, and old plain text is encrypted', async () => {
  const { call, admin, pm, redis } = await harness();
  assert.equal((await connect(call, admin)).statusCode, 200);
  assert.equal(dumpRedis(redis).includes('pm-send'), false, 'never stored in plain text');

  const rotated = await call('PUT', '/api/settings', { token: admin, body: { rotateEncryptionKey: true } });
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal((await call('POST', '/api/mail/test', { token: admin })).statusCode, 200);
  assert.equal(pm.sent.length, 1);

  // An install from before encryption: the token sits in plain text.
  const saved = JSON.parse(await redis.cmd('GET', 'tr:settings'));
  await redis.cmd('SET', 'tr:settings', JSON.stringify({ ...saved, mail: { ...saved.mail, serverToken: 'pm-send' } }));
  assert.equal((await call('POST', '/api/mail/test', { token: admin })).statusCode, 200);
  assert.equal(pm.sent.length, 2);
  assert.equal(dumpRedis(redis).includes('pm-send'), false, 'encrypted on the first request');
});

test('a sending token that cannot be read says how to fix it', async () => {
  const { call, admin, redis } = await harness();
  await connect(call, admin);
  await redis.cmd('DEL', 'tr:keyring');
  const r = await call('POST', '/api/mail/test', { token: admin });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /Postmark sending token cannot be used.*Email tab/);
});
