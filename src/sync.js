import { assignTable, exposureFor, releaseAt } from './allocation.js';

// Applies one OpenTable event (created, modified, cancelled) to SevenRooms.
// Safe to replay: the same event twice produces one reservation.
export class SyncService {
  constructor({ config, store, sevenRooms, alert, clock = null }) {
    this.config = config;
    this.clock = clock;
    this.store = store;
    this.sevenRooms = sevenRooms;
    this.alert = alert;
  }

  async handle(event) {
    try {
      if (event.type === 'cancelled') return await this.#cancel(event);
      return await this.#upsert(event);
    } catch (err) {
      await this.alert.send({
        severity: 'high',
        code: 'sync_failed',
        message: `OpenTable ${event.confirmation} (${event.type}) did not reach SevenRooms: ${err.message}`,
        event,
      });
      throw err;
    }
  }

  async #upsert(event) {
    const existing = await this.store.get(event.confirmation);
    if (existing?.status === 'active' && sameBooking(existing, event)) return { action: 'noop', record: existing };

    const moving = existing?.status === 'active';
    const sitting = sittingKey(this.config, event);
    const booked = await this.store.takenTables(event.date, sitting);
    if (moving && existing.date === event.date) booked.delete(existing.table);
    // A released table belongs to SevenRooms again and may already be resold.
    const prefix = `${event.date}|${sitting}|`;
    const released = await this.store.releasedKeys();
    const taken = new Set(booked);
    for (const key of released) {
      if (key.startsWith(prefix)) taken.add(key.slice(prefix.length));
    }

    const placement = assignTable(this.config, event, taken);
    if (!placement.ok) {
      const exposure = sitting && exposureFor(this.config, {
        date: event.date, sitting, taken: booked, released, closed: await this.closedKeys(),
      });
      const oversold = exposure?.exposed.length > 0;
      await this.alert.send({
        severity: 'high',
        code: placement.reason,
        message: `OpenTable ${event.confirmation}: party of ${event.partySize} on ${event.date} at ${event.time} has no protected table (${placement.reason}). Seat manually and review the OpenTable allocation.`
          + (oversold ? ` OpenTable sold this after release with ${exposure.exposed.length} released table(s) still open there (${exposure.exposed.join(', ')}). Check SevenRooms for a clash now and stop online sales for the ${sitting} sitting in OpenTable.` : ''),
        event,
      });
      return { action: 'rejected', reason: placement.reason };
    }

    const reservation = toReservation(event, placement.table);
    let sevenRoomsId;
    if (moving) {
      sevenRoomsId = existing.sevenRoomsId;
      await this.sevenRooms.updateReservation(sevenRoomsId, reservation);
    } else {
      sevenRoomsId = await this.sevenRooms.createReservation(reservation);
    }

    const record = {
      confirmation: event.confirmation,
      sevenRoomsId,
      status: 'active',
      date: event.date,
      time: event.time,
      partySize: event.partySize,
      sitting: placement.sitting,
      table: placement.table,
      guest: event.guest,
    };
    // A booking made after release time draws on the reserve. Recording it
    // gives the evidence for how large the reserve needs to be.
    const now = this.clock?.();
    const lateNow = Boolean(now && now >= releaseAt(this.config, event.date));
    record.bookedAt = existing?.bookedAt ?? now ?? null;
    record.late = Boolean(existing?.late) || lateNow;
    await this.store.put(record);
    if (lateNow) await this.#checkReserve(record, released);
    return { action: moving ? 'updated' : 'created', record };
  }

  async closedKeys() {
    return this.store.closedInOpenTableKeys ? this.store.closedInOpenTableKeys() : new Set();
  }

  // After a late booking: say how much reserve is left while released tables
  // are still open in OpenTable. With none left, the host must stop online
  // sales for the sitting before OpenTable sells a table SevenRooms has resold.
  async #checkReserve(record, released) {
    const taken = await this.store.takenTables(record.date, record.sitting);
    const e = exposureFor(this.config, {
      date: record.date, sitting: record.sitting, taken, released, closed: await this.closedKeys(),
    });
    if (e.exposed.length === 0) return;
    const where = `${record.date} ${record.sitting} sitting`;
    if (e.atRisk) {
      await this.alert.send({
        severity: 'high',
        code: 'reserve_exhausted',
        message: `Late OpenTable booking ${record.confirmation} took the last reserve table for ${where}. ${e.exposed.length} released table(s) are still open in OpenTable. Stop online sales for this sitting in OpenTable now, then mark the tables closed in Table Runner.`,
        tables: e.exposed.map((table) => ({ date: record.date, sitting: record.sitting, table })),
      });
    } else {
      await this.alert.send({
        severity: 'medium',
        code: 'reserve_used',
        message: `Late OpenTable booking ${record.confirmation} placed on reserve table ${record.table} for ${where}. ${e.reserve.length} reserve table(s) left (largest seats ${e.largestReserve}); ${e.exposed.length} released table(s) still open in OpenTable.`,
      });
    }
  }

  async #cancel(event) {
    const existing = await this.store.get(event.confirmation);
    if (!existing) {
      await this.alert.send({
        severity: 'medium',
        code: 'cancel_unknown',
        message: `OpenTable cancellation ${event.confirmation} has no matching synced booking. Check SevenRooms by hand.`,
        event,
      });
      return { action: 'unknown' };
    }
    if (existing.status === 'cancelled') return { action: 'noop', record: existing };

    await this.sevenRooms.cancelReservation(existing.sevenRoomsId);
    const record = { ...existing, status: 'cancelled' };
    await this.store.put(record);
    return { action: 'cancelled', record };
  }
}

function sittingKey(config, event) {
  return config.sittings.find((s) => event.time >= s.start && event.time < s.end)?.name;
}

function sameBooking(record, event) {
  return record.date === event.date && record.time === event.time && record.partySize === event.partySize;
}

function toReservation(event, table) {
  return {
    date: event.date,
    time: event.time,
    partySize: event.partySize,
    table,
    guest: event.guest,
    notes: event.notes ?? '',
    source: 'opentable',
    externalRef: event.confirmation,
  };
}
