import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDemo } from '../scripts/demo.js';
import { createDashboardServer } from '../src/server.js';

const clock = () => '2026-11-04T10:00';

async function start(opts) {
  const app = await buildDemo({ clock });
  const server = createDashboardServer(app, opts);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, server, base };
}

test('dashboard and API respond with demo state', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  assert.match(await (await fetch(base)).text(), /Table Runner/);

  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.mode.demo, true);
  assert.equal(status.venueName, 'Broadcaster');
  assert.ok(status.lastReconciliation.issues >= 1);

  const day = await (await fetch(`${base}/api/day?date=2026-11-04`)).json();
  assert.equal(day.date, '2026-11-04');
  assert.ok(day.sittings.length > 0);

  const week = await (await fetch(`${base}/api/week?from=2026-11-04`)).json();
  assert.equal(week.length, 7);

  assert.equal((await fetch(`${base}/api/day?date=bad`)).status, 400);
});

test('alerts can be acknowledged and leave an audit entry', async (t) => {
  const { server, base, app } = await start();
  t.after(() => server.close());

  const [first] = await (await fetch(`${base}/api/alerts`)).json();
  const res = await fetch(`${base}/api/alerts/${first.id}/ack`, { method: 'POST' });
  const acked = await res.json();
  assert.equal(acked.acknowledged, true);
  // The demo server has no named users, so it acknowledges as the dashboard.
  assert.deepEqual(acked.acknowledgedBy, { name: 'dashboard', email: null });
  assert.ok(!(await (await fetch(`${base}/api/alerts`)).json()).some((a) => a.id === first.id));
  assert.equal(app.activity.list()[0].kind, 'alert.ack');
  assert.equal(app.activity.list()[0].message, `Alert ${first.id} acknowledged by dashboard: ${first.code}`);
});

test('inbound email endpoint syncs a booking', async (t) => {
  const { server, base } = await start();
  t.after(() => server.close());

  const res = await fetch(`${base}/api/inbound-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject: 'Cancelled reservation', text: 'Confirmation #: OT1001' }),
  });
  assert.equal((await res.json()).action, 'cancelled');
});

test('password protects every route', async (t) => {
  const { server, base } = await start({ password: 's3cret' });
  t.after(() => server.close());

  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  const auth = { authorization: `Basic ${Buffer.from('gm:s3cret').toString('base64')}` };
  assert.equal((await fetch(`${base}/api/status`, { headers: auth })).status, 200);
});
