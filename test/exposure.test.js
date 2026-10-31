import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdBackFor, pickReserve, releasesDue, exposureFor } from '../src/allocation.js';
import { validateFloorPlan } from '../src/settings.js';
import { buildDemo } from '../src/demo-data.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { MemorySevenRooms } from '../src/adapters/sevenrooms.js';
import { OpenTableLedger } from '../src/adapters/opentable-ledger.js';
import { MemoryAlerts } from '../src/alert.js';
import { ActivityLog } from '../src/activity.js';
import { exampleConfig as config } from '../config/allocation.example.js';

// OpenTable gives no way to close a table, so a released table stays bookable
// there. These tests cover the reserve that absorbs late OpenTable bookings,
// the alerts when it runs out, and the host confirming tables closed.

const FRI = '2026-11-06'; // late sitting: T1, T2 (2 seats), T10, T11 (4 seats)
const AFTER_RELEASE = '2026-11-05T09:00';

function liveApp(cfg = config, now = AFTER_RELEASE) {
  let t = now;
  const store = new MemoryStore();
  const alerts = new MemoryAlerts({ clock: () => t });
  const app = createApp({
    config: cfg, store, sevenRooms: new MemorySevenRooms(), alerts, ledger: new OpenTableLedger(),
    activity: new ActivityLog({ clock: () => t }), clock: () => t, mode: { demo: true },
  });
  return { app, store, alerts, setNow: (v) => { t = v; } };
}

const ev = (confirmation, partySize = 2, time = '19:30', date = FRI) => ({
  source: 'opentable', type: 'created', confirmation, partySize, date, time, guest: { firstName: 'A', lastName: 'B' },
});

test('holdBack accepts a number, per sitting, and per weekday and sitting', () => {
  const c = (holdBack) => ({ ...config, release: { ...config.release, holdBack } });
  assert.equal(holdBackFor(c(undefined), FRI, 'late'), 0);
  assert.equal(holdBackFor(c(2), FRI, 'late'), 2);
  assert.equal(holdBackFor(c({ default: 1, late: 2 }), FRI, 'late'), 2);
  assert.equal(holdBackFor(c({ default: 1, late: 2 }), FRI, 'early'), 1);
  assert.equal(holdBackFor(c({ default: 1, fri: { late: 3 } }), FRI, 'late'), 3);
  assert.equal(holdBackFor(c({ default: 1, fri: { late: 3 } }), FRI, 'early'), 1);
});

test('the reserve keeps the largest unsold tables', () => {
  assert.deepEqual(pickReserve(config, ['T1', 'T10', 'T2', 'T11'], 2), ['T10', 'T11']);
  assert.deepEqual(pickReserve(config, ['T1'], 2), ['T1']);
});

test('release holds the reserve back and releases the rest', () => {
  const due = releasesDue(config, { now: AFTER_RELEASE, fromDate: FRI, toDate: FRI, occupied: () => new Set() });
  const late = due.filter((d) => d.sitting === 'late').map((d) => d.table).sort();
  assert.deepEqual(late, ['T1', 'T11', 'T2']); // T10 held: largest, then id order
  assert.deepEqual(due.filter((d) => d.sitting === 'early').map((d) => d.table), ['T1']);
});

test('exposure counts released tables not confirmed closed in OpenTable', () => {
  const released = new Set([`${FRI}|late|T1`, `${FRI}|late|T2`]);
  const e = exposureFor(config, { date: FRI, sitting: 'late', taken: new Set(['T11']), released, closed: new Set([`${FRI}|late|T1`]) });
  assert.deepEqual(e.exposed, ['T2']);
  assert.deepEqual(e.reserve, ['T10']);
  assert.equal(e.atRisk, false);
});

test('late OpenTable bookings use the reserve, then alert when it runs out', async () => {
  const { app, alerts } = liveApp();
  await app.release();
  const r1 = await app.ingestEvent(ev('L1', 2));
  assert.equal(r1.action, 'created');
  assert.equal(r1.record.table, 'T10');
  assert.equal(r1.record.late, true);
  assert.equal(alerts.sent.at(-1).code, 'reserve_exhausted');
  assert.equal(alerts.sent.at(-1).severity, 'high');

  const r2 = await app.ingestEvent(ev('L2', 2));
  assert.equal(r2.action, 'rejected');
  assert.match(alerts.sent.at(-1).message, /still open there/);

  const day = await app.dayView(FRI);
  const late = day.sittings.find((s) => s.name === 'late');
  assert.equal(late.exposed, 3);
  assert.equal(late.reserve, 0);
  assert.equal(late.atRisk, true);
  assert.equal(late.late, 1);
});

test('reserve_used while reserve remains', async () => {
  const cfg = { ...config, release: { ...config.release, holdBack: { default: 1, late: 2 } } };
  const { app, alerts } = liveApp(cfg);
  await app.release();
  await app.ingestEvent(ev('L1', 2));
  assert.equal(alerts.sent.at(-1).code, 'reserve_used');
});

test('bookings before release time are not late and raise no reserve alert', async () => {
  const { app, alerts } = liveApp(config, '2026-11-01T12:00');
  const r = await app.ingestEvent(ev('E1', 2));
  assert.equal(r.record.late, false);
  assert.equal(alerts.sent.length, 0);
});

test('confirming tables closed in OpenTable removes the exposure', async () => {
  const { app } = liveApp();
  await app.release();
  await app.ingestEvent(ev('L1', 2));
  const r = await app.confirmClosed({ date: FRI, sitting: 'late' });
  assert.equal(r.closed.length, 3);
  const late = (await app.dayView(FRI)).sittings.find((s) => s.name === 'late');
  assert.equal(late.exposed, 0);
  assert.equal(late.atRisk, false);
  const status = await app.status();
  assert.ok(!status.exposure.atRisk.some((x) => x.date === FRI && x.sitting === 'late'));
});

test('late demand report sizes the reserve from past nights', async () => {
  const { app, setNow } = liveApp(config, '2026-11-01T12:00');
  // Friday 6 Nov: two late bookings after release. Friday 13 Nov: none.
  await app.ingestEvent(ev('A1', 2, '19:30', '2026-11-06'));
  setNow('2026-11-05T09:00');
  await app.ingestEvent(ev('A2', 2, '20:00', '2026-11-06'));
  await app.ingestEvent(ev('A3', 4, '20:30', '2026-11-06'));
  await app.ingestEvent(ev('B1', 2, '19:30', '2026-11-13'));
  setNow('2026-11-20T10:00');
  const r = await app.lateDemand({ weeks: 4 });
  const friLate = r.rows.find((x) => x.weekday === 'fri' && x.sitting === 'late');
  assert.equal(friLate.nights, 2);
  assert.equal(friLate.max, 2);
  assert.equal(friLate.holdBack, 1);
  assert.equal(friLate.coveredPct, 50);
});

test('floor plan validation checks holdBack', () => {
  const c = (holdBack) => ({ ...config, release: { ...config.release, holdBack } });
  assert.deepEqual(validateFloorPlan(c({ default: 1, late: 2, fri: { late: 3 } })), []);
  assert.ok(validateFloorPlan(c(-1)).length);
  assert.ok(validateFloorPlan(c({ brunch: 1 })).length);
  assert.ok(validateFloorPlan(c({ fri: { late: 'two' } })).length);
});

test('demo builds with exposure on the status', async () => {
  const app = await buildDemo({ config, clock: () => '2026-11-05T09:00' });
  const s = await app.status();
  assert.equal(typeof s.exposure.exposed, 'number');
});
