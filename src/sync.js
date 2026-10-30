import { assignTable } from './allocation.js';

// Applies one OpenTable event (created, modified, cancelled) to SevenRooms.
// Safe to replay: the same event twice produces one reservation.
export class SyncService {
  constructor({ config, store, sevenRooms, alert }) {
    this.config = config;
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
    const taken = await this.store.takenTables(event.date, sittingKey(this.config, event));
    if (moving && existing.date === event.date) taken.delete(existing.table);

    const placement = assignTable(this.config, event, taken);
    if (!placement.ok) {
      await this.alert.send({
        severity: 'high',
        code: placement.reason,
        message: `OpenTable ${event.confirmation}: party of ${event.partySize} on ${event.date} at ${event.time} has no protected table (${placement.reason}). Seat manually and review the OpenTable allocation.`,
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
    await this.store.put(record);
    return { action: moving ? 'updated' : 'created', record };
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
