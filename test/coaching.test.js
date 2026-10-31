import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reserveFor, median, weekStart, learnNights, learnHabits, coachingNotes, buildCoaching } from '../src/coaching.js';
import { buildDemo } from '../src/demo-data.js';
import { withStartingHoldBack, validateFloorPlan } from '../src/settings.js';
import { exampleConfig } from '../config/allocation.example.js';

const config = { ...exampleConfig, release: { ...exampleConfig.release, holdBack: 1 } };

test('reserve from the forecast covers 90% of nights', () => {
  // No late demand at all: no reserve needed.
  assert.equal(reserveFor(0.01, 10), 0);
  // About one late booking a night, with plenty of evidence: two or three.
  assert.ok([2, 3].includes(reserveFor(40, 40)));
  // More demand never needs a smaller reserve.
  assert.ok(reserveFor(80, 40) >= reserveFor(40, 40));
});

test('median and week start', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(weekStart('2026-11-01'), '2026-10-26'); // Sunday -> Monday before
  assert.equal(weekStart('2026-10-26'), '2026-10-26');
});

test('the model learns which nights get late bookings', () => {
  const bookings = [];
  let n = 0;
  // Eight Fridays with two late bookings each on the late sitting; other
  // nights none.
  for (let w = 1; w <= 8; w++) {
    const date = new Date(Date.UTC(2026, 9, 30 - 7 * (w - 1))).toISOString().slice(0, 10); // Fridays back from 30 Oct
    for (let i = 0; i < 2; i++) {
      bookings.push({ confirmation: `L${++n}`, date, sitting: 'late', status: 'active', bookedAt: `${date}T10:00`, late: true });
    }
    bookings.push({ confirmation: `E${++n}`, date, sitting: 'late', status: 'active', bookedAt: '2026-09-01T10:00', late: false });
  }
  const model = learnNights(config, bookings, { today: '2026-10-31' });
  const fri = model.rows.find((r) => r.weekday === 'fri' && r.sitting === 'late');
  const tue = model.rows.find((r) => r.weekday === 'tue' && r.sitting === 'late');
  assert.equal(fri.confidence, 'good');
  assert.ok(fri.expectedLate > 1.2); // observed 2, pulled slightly towards the venue average
  assert.ok(fri.recommendedReserve >= 2);
  assert.ok(tue.expectedLate < 0.5);
  assert.ok(tue.recommendedReserve < fri.recommendedReserve);
  const notes = coachingNotes(model, []);
  assert.ok(notes.some((x) => x.area === 'Reserve size' && /Fri late/.test(x.title)));
});

test('habits measure closing and alert response by week', () => {
  const times = {
    released: new Map([['2026-10-30|late|T1', '2026-10-28T16:00'], ['2026-10-30|late|T2', '2026-10-28T16:00']]),
    closed: new Map([['2026-10-30|late|T1', '2026-10-28T17:00']]),
  };
  const alerts = [
    { severity: 'high', code: 'reserve_exhausted', at: '2026-10-29T18:00', acknowledgedAt: '2026-10-29T18:10' },
    { severity: 'high', code: 'over_allocation', message: 'x still open there', at: '2026-10-29T19:00', acknowledgedAt: '2026-10-29T20:00' },
  ];
  const weeks = learnHabits(config, { times, alerts, now: '2026-10-31T12:00', weeks: 2 });
  const w = weeks.at(-1);
  assert.equal(w.weekStart, '2026-10-26');
  assert.equal(w.released, 2);
  assert.equal(w.closedBeforeServicePct, 50);
  assert.equal(w.medianHoursToClose, 1);
  assert.equal(w.ackWithin30Pct, 50);
  assert.equal(w.reserveExhausted, 1);
  assert.equal(w.oversold, 1);
  const notes = coachingNotes({ rows: [] }, weeks);
  assert.equal(notes[0].tone, 'improve');
  assert.ok(notes.some((n) => n.area === 'Double-booking risk'));
});

test('with no history the coaching says it is still learning', () => {
  const c = buildCoaching(config, { bookings: [], times: { released: new Map(), closed: new Map() }, alerts: [], now: '2026-10-31T12:00' });
  assert.equal(c.dataFrom, null);
  assert.ok(c.notes.some((n) => n.area === 'How much the model knows'));
});

test('the demo has history for the coaching to learn from', async () => {
  const app = await buildDemo({ config: exampleConfig, clock: () => '2026-10-31T12:00' });
  const c = await app.coaching();
  assert.ok(c.model.rows.length > 0);
  assert.ok(c.habits.some((w) => w.released > 0));
  assert.ok(c.notes.length > 0);
});

test('starting reserve is added once to a saved floor plan without one', () => {
  const old = { floorPlan: { ...exampleConfig, release: { daysBefore: 2, time: '16:00' } } };
  const next = withStartingHoldBack(old);
  assert.deepEqual(next.floorPlan.release.holdBack, { default: 1, fri: { late: 2 }, sat: { late: 2 } });
  assert.deepEqual(validateFloorPlan(next.floorPlan), []);
  assert.equal(withStartingHoldBack(next), null);
  // A figure an admin set is never overwritten, including zero.
  assert.equal(withStartingHoldBack({ floorPlan: { ...exampleConfig, release: { ...exampleConfig.release, holdBack: 0 } } }), null);
  // A venue with no "late" sitting gets the default only.
  const noLate = withStartingHoldBack({ floorPlan: { ...old.floorPlan, sittings: [{ name: 'dinner', start: '17:00', end: '23:00' }] } });
  assert.deepEqual(noLate.floorPlan.release.holdBack, { default: 1 });
});
