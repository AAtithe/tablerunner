import { SyncService } from './sync.js';
import { parseOpenTableEmail } from './adapters/opentable-email.js';
import { reconcile } from './reconcile.js';
import { runReleases } from './release.js';
import { addDays, allocatedTables, releaseAt } from './allocation.js';
import { MemoryState, MemoryLock } from './store.js';

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
  const sync = new SyncService({ config, store, sevenRooms, alert: alerts });

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

    async reconcile({ days = 7 } = {}) {
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
      const result = { at: clock(), fromDate, toDate, checked: ot.length, issues };
      await state.set('lastReconciliation', result);
      await activity.add('reconcile', issues.length ? `Reconciliation: ${issues.length} issue(s) across ${ot.length} bookings` : `Reconciliation clean: ${ot.length} bookings checked`);
      return result;
    },

    async release({ days = 7, manual = manualRelease } = {}) {
      return lock.run(async () => {
        const now = clock();
        const fromDate = now.slice(0, 10);
        const due = await runReleases({
          config, store, sevenRooms, alert: alerts, now, fromDate, toDate: addDays(fromDate, days - 1), manual,
        });
        await state.set('lastRelease', { at: now, count: due.length, manual });
        if (due.length) await activity.add('release', `${manual ? 'Host asked to release' : 'Released'} ${due.length} unsold OpenTable table(s)`, { tables: due });
        return due;
      });
    },

    async dayView(date) {
      const released = await store.releasedKeys();
      const bookings = await store.active({ fromDate: date, toDate: date });
      const sittings = config.sittings.map((s) => {
        const tables = allocatedTables(config, date, s.name).map((id) => {
          const seats = config.tables[id]?.seats ?? 0;
          const booking = bookings.find((b) => b.sitting === s.name && b.table === id);
          if (booking) return { id, seats, status: 'sold', booking };
          if (released.has(`${date}|${s.name}|${id}`)) return { id, seats, status: 'released' };
          return { id, seats, status: 'open' };
        });
        return { ...s, tables, ...totals(tables) };
      });
      return { date, releaseAt: releaseAt(config, date), sittings, ...totals(sittings.flatMap((s) => s.tables)) };
    },

    async weekView(fromDate, days = 7) {
      const out = [];
      for (let i = 0; i < days; i++) out.push(await this.dayView(addDays(fromDate, i)));
      return out.map((d) => ({
        date: d.date,
        sittings: d.sittings.map(({ name, allocated, sold, released, seatsAllocated, covers }) => ({ name, allocated, sold, released, seatsAllocated, covers })),
        allocated: d.allocated,
        sold: d.sold,
        covers: d.covers,
      }));
    },

    async status() {
      const [openAlerts, lastEmailAt, lastReconciliation, lastRelease] = await Promise.all([
        alerts.open(), state.get('lastEmailAt'), state.get('lastReconciliation'), state.get('lastRelease'),
      ]);
      return {
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
