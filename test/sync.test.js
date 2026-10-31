import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignTable, releaseAt, weekday } from '../src/allocation.js';
import { MemoryStore } from '../src/store.js';
import { MemorySevenRooms } from '../src/adapters/sevenrooms.js';
import { MemoryAlerts } from '../src/alert.js';
import { SyncService } from '../src/sync.js';
import { reconcile } from '../src/reconcile.js';
import { runReleases } from '../src/release.js';
import { handleInboundEmail } from '../src/index.js';

import { exampleConfig as config } from '../config/allocation.example.js';
const FRI = '2026-11-06';

function setup() {
  const store = new MemoryStore();
  const sevenRooms = new MemorySevenRooms();
  const alert = new MemoryAlerts();
  const sync = new SyncService({ config, store, sevenRooms, alert });
  return { store, sevenRooms, alert, sync };
}

const booking = (over = {}) => ({
  source: 'opentable',
  type: 'created',
  confirmation: 'OT100',
  partySize: 2,
  date: FRI,
  time: '19:30',
  guest: { firstName: 'Ada', lastName: 'Lovelace' },
  ...over,
});

test('weekday and release time', () => {
  assert.equal(weekday(FRI), 'fri');
  assert.equal(releaseAt(config, FRI), '2026-11-04T16:00');
});

test('assigns smallest protected table that fits', () => {
  assert.deepEqual(assignTable(config, { date: FRI, time: '19:30', partySize: 2 }, new Set()), {
    ok: true, table: 'T1', sitting: 'late',
  });
  assert.equal(assignTable(config, { date: FRI, time: '19:30', partySize: 3 }, new Set()).table, 'T10');
});

test('never assigns a table outside the OpenTable allocation', () => {
  // T20 (six seats) exists but is not allocated to OpenTable.
  const r = assignTable(config, { date: FRI, time: '19:30', partySize: 6 }, new Set());
  assert.deepEqual(r, { ok: false, reason: 'over_allocation', sitting: 'late' });
});

test('create is idempotent', async () => {
  const { sync, sevenRooms } = setup();
  assert.equal((await sync.handle(booking())).action, 'created');
  assert.equal((await sync.handle(booking())).action, 'noop');
  assert.equal(sevenRooms.reservations.size, 1);
});

test('fills allocation then rejects with an alert, no double booking', async () => {
  const { sync, alert, sevenRooms } = setup();
  // Friday late: T1, T2 (2 seats), T10, T11 (4 seats).
  for (let i = 0; i < 4; i++) await sync.handle(booking({ confirmation: `OT${i}` }));
  const tables = [...sevenRooms.reservations.values()].map((r) => r.table).sort();
  assert.deepEqual(tables, ['T1', 'T10', 'T11', 'T2']);

  const r = await sync.handle(booking({ confirmation: 'OT9' }));
  assert.equal(r.action, 'rejected');
  assert.equal(alert.sent[0].code, 'over_allocation');
});

test('modification moves the booking and frees the old table', async () => {
  const { sync, store, sevenRooms } = setup();
  await sync.handle(booking());
  const r = await sync.handle(booking({ type: 'modified', partySize: 4 }));
  assert.equal(r.action, 'updated');
  assert.equal(r.record.table, 'T10');
  assert.equal(sevenRooms.reservations.size, 1);
  assert.deepEqual([...(await store.takenTables(FRI, 'late'))], ['T10']);
});

test('cancellation cancels in SevenRooms and frees the table', async () => {
  const { sync, store, sevenRooms } = setup();
  await sync.handle(booking());
  const r = await sync.handle({ source: 'opentable', type: 'cancelled', confirmation: 'OT100' });
  assert.equal(r.action, 'cancelled');
  assert.equal(sevenRooms.reservations.get('sr_1').status, 'cancelled');
  assert.equal((await store.takenTables(FRI, 'late')).size, 0);
});

test('SevenRooms failure raises an alert and is not swallowed', async () => {
  const { sync, sevenRooms, alert } = setup();
  sevenRooms.createReservation = async () => { throw new Error('503'); };
  await assert.rejects(sync.handle(booking()));
  assert.equal(alert.sent[0].code, 'sync_failed');
});

test('reconciliation finds missing, mismatched and orphaned bookings', () => {
  const issues = reconcile({
    openTable: [
      { confirmation: 'A', date: FRI, time: '19:00', partySize: 2 },
      { confirmation: 'B', date: FRI, time: '20:00', partySize: 4 },
    ],
    sevenRooms: [
      { externalRef: 'B', source: 'opentable', date: FRI, time: '20:00', partySize: 2 },
      { externalRef: 'C', source: 'opentable', date: FRI, time: '21:00', partySize: 2 },
      { externalRef: 'walkin', source: 'direct', date: FRI, time: '21:00', partySize: 2 },
    ],
  });
  assert.deepEqual(issues.map((i) => i.code).sort(), ['field_mismatch', 'missing_in_sevenrooms', 'orphan_in_sevenrooms']);
});

test('releases only unsold tables, only after release time, only once', async () => {
  const { sync, store, sevenRooms, alert } = setup();
  await sync.handle(booking());
  const args = { config, store, sevenRooms, alert, fromDate: FRI, toDate: FRI };

  assert.equal((await runReleases({ ...args, now: '2026-11-04T15:59' })).length, 0);
  const due = await runReleases({ ...args, now: '2026-11-04T16:00' });
  // Friday: early T1, T10 plus late T2, T10, T11 (late T1 is sold).
  assert.equal(due.length, 5);
  assert.ok(!due.some((d) => d.sitting === 'late' && d.table === 'T1'));
  assert.equal((await runReleases({ ...args, now: '2026-11-04T17:00' })).length, 0);
});

test('manual release mode sends the host a checklist', async () => {
  const { store, sevenRooms, alert } = setup();
  await runReleases({ config, store, sevenRooms, alert, now: '2026-11-05T09:00', fromDate: FRI, toDate: FRI, manual: true });
  assert.equal(alert.sent[0].code, 'manual_release_due');
  assert.equal(sevenRooms.releases.length, 0);
});

test('release always closes the table on OpenTable too', async () => {
  const { store, sevenRooms, alert } = setup();
  const args = { config, store, sevenRooms, alert, now: '2026-11-05T09:00', fromDate: FRI, toDate: FRI };
  await runReleases(args);
  assert.equal(alert.sent.at(-1).code, 'close_in_opentable');

  const closed = [];
  const s2 = setup();
  await runReleases({ ...args, store: s2.store, alert: s2.alert, openTable: { closeTable: async (t) => closed.push(t) } });
  assert.equal(closed.length, 6);
  assert.equal(s2.alert.sent.length, 0);
});

test('a booking arriving after release never lands on a released table', async () => {
  const { sync, store, sevenRooms, alert } = setup();
  await runReleases({ config, store, sevenRooms, alert, now: '2026-11-05T09:00', fromDate: FRI, toDate: FRI });
  const r = await sync.handle(booking());
  assert.equal(r.action, 'rejected');
  assert.equal(sevenRooms.reservations.size, 0);
});

// Synthetic email: format invented for testing until real OpenTable samples arrive.
test('inbound email flows through to SevenRooms; unparseable email alerts', async () => {
  const { sync, alert, sevenRooms } = setup();
  const ok = await handleInboundEmail({
    subject: 'New reservation',
    text: 'Confirmation #: OT555\nGuest name: Grace Hopper\nParty size: 3\nDate: 2026-11-06\nTime: 7:45 pm\nEmail: grace@example.com',
  }, { sync, alert });
  assert.equal(ok.action, 'created');
  assert.equal([...sevenRooms.reservations.values()][0].time, '19:45');

  const bad = await handleInboundEmail({ subject: 'New reservation', text: 'nothing useful' }, { sync, alert });
  assert.equal(bad.action, 'unparseable');
  assert.equal(alert.sent[0].code, 'unparseable_email');
});

test('SevenRooms refusing a taken table raises a table_taken alert', async () => {
  const { sync, sevenRooms, alert } = setup();
  // A host has sold protected table T1 directly in SevenRooms.
  await sevenRooms.createReservation({ date: FRI, time: '19:00', partySize: 2, table: 'T1', sitting: 'late', source: 'direct' });
  await assert.rejects(sync.handle(booking()), (err) => err.code === 'table_taken');
  assert.equal(alert.sent[0].code, 'table_taken');
  assert.match(alert.sent[0].message, /T1/);
});
