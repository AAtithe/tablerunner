// Synthetic demo: in-memory SevenRooms, invented bookings, and every failure
// the dashboard must surface. No vendor is contacted. Used by the local demo
// server, the tests and the static build.
import { createApp } from './app.js';
import { MemoryStore } from './store.js';
import { MemorySevenRooms } from './adapters/sevenrooms.js';
import { OpenTableLedger } from './adapters/opentable-ledger.js';
import { MemoryAlerts } from './alert.js';
import { ActivityLog } from './activity.js';
import { addDays, releaseAt, weekday } from './allocation.js';
import { londonNow } from './clock.js';
import { floorPlanStatus } from './mode.js';

export async function buildDemo({ config, clock: realClock = () => londonNow(), note } = {}) {
  // The demo replays six weeks of past service at their own times, so the
  // coaching section has history to learn from. `sim` holds the replay time.
  let sim = null;
  const clock = () => sim ?? realClock();
  const sevenRooms = new MemorySevenRooms();
  const alerts = new MemoryAlerts({ clock });
  const app = createApp({
    config,
    store: new MemoryStore(),
    sevenRooms,
    alerts,
    ledger: new OpenTableLedger(),
    activity: new ActivityLog({ clock }),
    clock,
    mode: {
      demo: true,
      note,
      sevenRooms: { live: false, value: 'Not live', detail: 'In-memory stand-in (live client awaiting credentials)' },
      openTable: { live: false, value: 'Email ledger', detail: 'Partner API not confirmed' },
      emailParser: { live: false, value: 'Provisional', detail: 'Awaiting real OpenTable emails' },
      floorPlan: floorPlanStatus(config),
    },
  });

  const names = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Mary Somerville', 'Charles Babbage', 'Rosalind Franklin',
    'Isambard Brunel', 'Dorothy Hodgkin', 'Michael Faraday', 'Florence Nightingale', 'Tim Berners-Lee', 'Hedy Lamarr'];
  const early = ['12:30', '13:00', '17:30', '18:00'];
  const late = ['19:00', '19:30', '20:00', '20:30', '21:00'];
  let seed = 7;
  const rand = (n) => ((seed = (seed * 16807) % 2147483647) % n);
  const email = (subject, conf, name, party, date, time) => ({
    subject,
    text: `Confirmation #: ${conf}\nGuest name: ${name}\nParty size: ${party}\nDate: ${date}\nTime: ${time}\nEmail: guest${conf.toLowerCase()}@example.com`,
  });

  const today = clock().slice(0, 10);
  const at = (date, hm) => `${date}T${hm}`;
  const later = (t, mins) => {
    const d = new Date(`${t}:00Z`);
    d.setUTCMinutes(d.getUTCMinutes() + mins);
    return d.toISOString().slice(0, 16);
  };

  // Six weeks of history. Fridays and Saturdays get more late OpenTable
  // demand, and the team gets quicker at closing tables and answering
  // alerts as the weeks go on, which is what the coaching should pick up.
  let h = 5000;
  for (let back = 42; back >= 1; back--) {
    const date = addDays(today, -back);
    const weekend = ['fri', 'sat'].includes(weekday(date));
    const progress = (42 - back) / 42;
    sim = at(addDays(date, -5), '12:00');
    for (let i = 0; i < (weekend ? 3 : 1 + rand(2)); i++) {
      await app.ingestEmail(email('New reservation', `OT${++h}`, names[rand(names.length)], 2, date, rand(3) ? late[rand(late.length)] : early[rand(early.length)]));
    }
    const released = releaseAt(config, date);
    sim = released;
    const due = await app.release({ days: 3 });
    const closeAfter = Math.round(240 - progress * 200 + rand(60));
    sim = later(released, closeAfter);
    if (due.length && rand(10) < 4 + progress * 6) await app.confirmClosed({ date });
    const lateCount = weekend ? rand(4) : rand(2);
    for (let i = 0; i < lateCount; i++) {
      sim = at(date, i ? '17:40' : '11:15');
      await app.ingestEmail(email('New reservation', `OT${++h}`, names[rand(names.length)], 2, date, late[rand(late.length)]));
    }
    for (const a of await alerts.open()) {
      sim = later(a.at, Math.round(70 - progress * 60 + rand(20)));
      await alerts.acknowledge(a.id);
    }
  }
  sim = null;

  const sent = [];
  let n = 1000;
  for (let d = 0; d < 7; d++) {
    const date = addDays(today, d);
    const busy = d < 2 ? 4 : 2 + rand(3);
    for (let i = 0; i < busy; i++) {
      const lateSitting = rand(3) > 0;
      const time = lateSitting ? late[rand(late.length)] : early[rand(early.length)];
      const e = email('New reservation', `OT${++n}`, names[rand(names.length)], 1 + rand(4), date, time);
      sent.push(e);
      await app.ingestEmail(e);
    }
  }

  // Scenarios the dashboard must surface.
  await app.ingestEmail(sent[0]); // same email delivered twice
  await app.ingestEmail(email('Reservation modified', 'OT1003', 'Alan Turing', 4, addDays(today, 1), '20:00'));
  await app.ingestEmail({ subject: 'Reservation cancelled', text: 'Confirmation #: OT1005' });
  await app.ingestEmail(email('New reservation', 'OT2001', 'Hedy Lamarr', 6, addDays(today, 3), '20:00')); // no six-top allocated
  await app.ingestEmail({ subject: 'New reservation', text: 'Your booking details have moved to the OpenTable app.' }); // format change

  // Someone edits a synced booking by hand in SevenRooms.
  const drift = [...sevenRooms.reservations.values()].find((r) => r.status === 'active' && r.date === addDays(today, 2));
  if (drift) drift.partySize += 1;

  await app.release();
  await app.reconcile();
  return app;
}
