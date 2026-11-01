import { SyncService } from './sync.js';
import { parseOpenTableEmail } from './adapters/opentable-email.js';
import { reconcile } from './reconcile.js';
import { actorRecord } from './alert.js';
import { runReleases } from './release.js';
import { addDays, allocatedTables, releaseAt, exposureFor, holdBackFor, weekday } from './allocation.js';
import { MemoryState, MemoryLock } from './store.js';
import { buildCoaching } from './coaching.js';

// Wires the sync, releases and reconciliation together and keeps the state
// the dashboard reads: alerts, activity, last reconciliation.
//
// Every change to table occupancy (a booking or a release) runs under `lock`.
// On Vercel several function instances run at once, and without the lock two
// bookings arriving together could both be given the last table.
export function createApp({
  config, store, sevenRooms, alerts, ledger, activity, clock, mode,
  state = new MemoryState(), lock = new MemoryLock(), manualRelease = false,
}) {
  const closedKeys = async () => (store.closedInOpenTableKeys ? store.closedInOpenTableKeys() : new Set());
  const sync = new SyncService({ config, store, sevenRooms, alert: alerts, clock });

  async function ingestEvent(event, via) {
    return lock.run(async () => {
      await ledger.record(event);
      try {
        const result = await sync.handle(event);
        await activity.add(`sync.${result.action}`, describe(event, result), { confirmation: event.confirmation, via });
        return result;
      } catch (err) {
        await activity.add('sync.failed', `OpenTable ${event.confirmation} failed: ${err.message}`, { confirmation: event.confirmation });
        return { action: 'failed', error: err.message };
      }
    });
  }

  return {
    config,
    alerts,
    activity,

    async ingestEmail(email) {
      await state.set('lastEmailAt', clock());
      const parsed = parseOpenTableEmail(email);
      if (!parsed.ok) {
        await alerts.send({
          severity: 'high',
          code: 'unparseable_email',
          message: `${parsed.error}. Subject: "${parsed.subject}". Enter this booking in SevenRooms by hand and send the email to the sync owner.`,
        });
        await activity.add('email.unparseable', `Could not read email "${parsed.subject}"`);
        return { action: 'unparseable' };
      }
      return ingestEvent(parsed.event, 'email');
    },

    ingestEvent,

    today: () => clock().slice(0, 10),

    // `by` is the person who ran it from the dashboard ({ name, email });
    // left out for the scheduled runs, which keep their usual wording.
    async reconcile({ days = 7, by } = {}) {
      const who = by && actorRecord(by);
      const fromDate = clock().slice(0, 10);
      const toDate = addDays(fromDate, days - 1);
      const [ot, sr] = await Promise.all([
        ledger.listBookings({ fromDate, toDate }),
        sevenRooms.listReservations({ fromDate, toDate }),
      ]);
      const issues = reconcile({ openTable: ot, sevenRooms: sr });
      if (issues.length) {
        await alerts.send({
          severity: 'high',
          code: 'reconciliation_mismatch',
          message: `${issues.length} OpenTable/SevenRooms mismatch(es) for ${fromDate} to ${toDate}. Resolve before service.`,
          issues,
        });
      }
      const result = { at: clock(), fromDate, toDate, checked: ot.length, issues, by: who ?? null };
      await state.set('lastReconciliation', result);
      const outcome = issues.length ? `${issues.length} issue(s) across ${ot.length} bookings` : `clean, ${ot.length} bookings checked`;
      await activity.add('reconcile', who ? `Reconciliation run by ${who.name}: ${outcome}`
        : issues.length ? `Reconciliation: ${outcome}` : `Reconciliation clean: ${ot.length} bookings checked`, who ? { by: who } : {});
      return result;
    },

    async release({ days = 7, manual = manualRelease, by } = {}) {
      const who = by && actorRecord(by);
      return lock.run(async () => {
        const now = clock();
        const fromDate = now.slice(0, 10);
        const due = await runReleases({
          config, store, sevenRooms, alert: alerts, now, fromDate, toDate: addDays(fromDate, days - 1), manual,
        });
        await state.set('lastRelease', { at: now, count: due.length, manual, by: who ?? null });
        const what = `${manual ? 'host asked to release' : 'released'} ${due.length} unsold OpenTable table(s)`;
        // A run from the dashboard is recorded even when nothing was due, so
        // the record shows who checked and when.
        if (who) await activity.add('release', `Release run by ${who.name}: ${due.length ? what : 'nothing due'}`, { tables: due, by: who });
        else if (due.length) await activity.add('release', what[0].toUpperCase() + what.slice(1), { tables: due });
        return due;
      });
    },

    async dayView(date) {
      const [released, closed] = await Promise.all([store.releasedKeys(), closedKeys()]);
      const bookings = await store.active({ fromDate: date, toDate: date });
      const due = clock() >= releaseAt(config, date);
      const sittings = config.sittings.map((s) => {
        const tables = allocatedTables(config, date, s.name).map((id) => {
          const seats = config.tables[id]?.seats ?? 0;
          const key = `${date}|${s.name}|${id}`;
          const booking = bookings.find((b) => b.sitting === s.name && b.table === id);
          if (booking) return { id, seats, status: 'sold', booking };
          if (released.has(key)) return { id, seats, status: 'released', key, openTableClosed: closed.has(key) };
          return { id, seats, status: due ? 'reserve' : 'open' };
        });
        const taken = new Set(bookings.filter((b) => b.sitting === s.name).map((b) => b.table));
        const e = exposureFor(config, { date, sitting: s.name, taken, released, closed });
        return {
          ...s, tables, ...totals(tables),
          holdBack: holdBackFor(config, date, s.name),
          exposed: due ? e.exposed.length : 0,
          reserve: due ? e.reserve.length : 0,
          atRisk: due && e.atRisk,
          late: bookings.filter((b) => b.sitting === s.name && b.late).length,
        };
      });
      const sum = (k) => sittings.reduce((n, x) => n + x[k], 0);
      return {
        date, releaseAt: releaseAt(config, date), releaseDue: due, sittings,
        ...totals(sittings.flatMap((s) => s.tables)),
        exposed: sum('exposed'), reserve: sum('reserve'), late: sum('late'), atRisk: sittings.some((s) => s.atRisk),
      };
    },

    // A host confirms released tables are now closed in OpenTable. They stop
    // counting as exposure. Takes keys, or a date and sitting for all of it.
    async confirmClosed({ keys, date, sitting, by } = {}) {
      const who = by && actorRecord(by);
      return lock.run(async () => {
        const released = await store.releasedKeys();
        const wanted = Array.isArray(keys) ? keys.map(String)
          : [...released].filter((k) => k.startsWith(`${date}|${sitting ? `${sitting}|` : ''}`));
        const done = [];
        for (const k of wanted) {
          if (!released.has(k)) continue;
          await store.markClosedInOpenTable(k, clock());
          done.push(k);
        }
        if (done.length) {
          await activity.add('opentable.closed', `Marked ${done.length} table(s) closed in OpenTable${who ? ` by ${who.name}` : ''}: ${done.map((k) => k.split('|').slice(1).join(' ')).join(', ')}${date ? ` on ${date}` : ''}`,
            who ? { tables: done, by: who } : { tables: done });
        }
        return { closed: done };
      });
    },

    // Late OpenTable bookings per weekday and sitting over past service dates,
    // and the reserve that would have covered them. The basis for setting
    // release.holdBack: hold back enough to cover all but the rarest nights.
    async lateDemand({ weeks = 8 } = {}) {
      const toDate = addDays(clock().slice(0, 10), -1);
      const fromDate = addDays(toDate, -(weeks * 7) + 1);
      const bookings = (await store.all({ fromDate, toDate })).filter((b) => b.status === 'active' || b.status === 'cancelled');
      const tracked = bookings.filter((b) => b.bookedAt);
      const start = tracked.reduce((m, b) => (b.date < m ? b.date : m), toDate);
      const rows = new Map();
      for (let date = start; date <= toDate && tracked.length; date = addDays(date, 1)) {
        for (const s of config.sittings) {
          const key = `${weekday(date)}|${s.name}`;
          if (!rows.has(key)) rows.set(key, { weekday: weekday(date), sitting: s.name, nights: [], holdBack: holdBackFor(config, date, s.name) });
          rows.get(key).nights.push(tracked.filter((b) => b.date === date && b.sitting === s.name && b.late).length);
        }
      }
      const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      const out = [...rows.values()].map((r) => {
        const sorted = [...r.nights].sort((a, b) => a - b);
        const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] : 0;
        const covered = r.nights.filter((n) => n <= r.holdBack).length;
        return {
          weekday: r.weekday, sitting: r.sitting, nights: r.nights.length,
          average: r.nights.length ? Math.round((r.nights.reduce((a, b) => a + b, 0) / r.nights.length) * 10) / 10 : 0,
          p90, max: sorted.at(-1) ?? 0, holdBack: r.holdBack, recommended: p90,
          coveredPct: r.nights.length ? Math.round((covered / r.nights.length) * 100) : null,
        };
      }).sort((a, b) => order.indexOf(a.weekday) - order.indexOf(b.weekday) || a.sitting.localeCompare(b.sitting));
      return { fromDate: tracked.length ? start : null, toDate, weeks, rows: out };
    },

    // Learned recommendations and team habits. Reads up to 26 weeks of
    // history; recent weeks weigh most.
    async coaching({ weeks = 8 } = {}) {
      const now = clock();
      const today = now.slice(0, 10);
      const [bookings, times, allAlerts] = await Promise.all([
        store.all({ fromDate: addDays(today, -26 * 7), toDate: addDays(today, -1) }),
        store.eventTimes ? store.eventTimes() : { released: new Map(), closed: new Map() },
        alerts.all(),
      ]);
      return buildCoaching(config, { bookings, times, alerts: allAlerts, now, weeks });
    },

    async weekView(fromDate, days = 7) {
      const out = [];
      for (let i = 0; i < days; i++) out.push(await this.dayView(addDays(fromDate, i)));
      return out.map((d) => ({
        date: d.date,
        sittings: d.sittings.map(({ name, allocated, sold, released, seatsAllocated, covers, exposed, reserve, atRisk }) => ({ name, allocated, sold, released, seatsAllocated, covers, exposed, reserve, atRisk })),
        exposed: d.exposed,
        atRisk: d.atRisk,
        allocated: d.allocated,
        sold: d.sold,
        covers: d.covers,
      }));
    },

    async status() {
      const [openAlerts, lastEmailAt, lastReconciliation, lastRelease] = await Promise.all([
        alerts.open(), state.get('lastEmailAt'), state.get('lastReconciliation'), state.get('lastRelease'),
      ]);
      const week = await this.weekView(clock().slice(0, 10), 7);
      return {
        exposure: {
          exposed: week.reduce((n, d) => n + d.exposed, 0),
          atRisk: week.flatMap((d) => d.sittings.filter((x) => x.atRisk).map((x) => ({ date: d.date, sitting: x.name, exposed: x.exposed }))),
        },
        venue: config.venue,
        venueName: config.venueName ?? config.venue,
        now: clock(),
        mode,
        openAlerts: openAlerts.length,
        lastEmailAt,
        lastReconciliation: lastReconciliation && {
          at: lastReconciliation.at,
          checked: lastReconciliation.checked,
          issues: lastReconciliation.issues.length,
          by: lastReconciliation.by ?? null,
        },
        lastRelease,
      };
    },
  };
}

function totals(list) {
  return {
    allocated: list.length,
    sold: list.filter((t) => t.status === 'sold').length,
    released: list.filter((t) => t.status === 'released').length,
    seatsAllocated: list.reduce((n, t) => n + t.seats, 0),
    covers: list.reduce((n, t) => n + (t.booking?.partySize ?? 0), 0),
  };
}

function describe(event, result) {
  const who = event.guest ? `${event.guest.firstName} ${event.guest.lastName}`.trim() : '';
  switch (result.action) {
    case 'created': return `Booked ${who}, ${event.partySize} on ${event.date} ${event.time} at ${result.record.table}`;
    case 'updated': return `Moved ${who} to ${event.partySize} on ${event.date} ${event.time} at ${result.record.table}`;
    case 'cancelled': return `Cancelled ${event.confirmation}, ${result.record.table} on ${result.record.date} freed`;
    case 'rejected': return `No protected table for ${who}, ${event.partySize} on ${event.date} ${event.time} (${result.reason})`;
    case 'noop': return `Duplicate of ${event.confirmation} ignored`;
    default: return `${event.confirmation}: ${result.action}`;
  }
}
