// Booking ledger keyed by OpenTable confirmation number. It makes the sync
// idempotent and records which protected table each booking holds.
// In-memory implementation; swap for the production store behind the same API.

export class MemoryStore {
  constructor() {
    this.bookings = new Map();
    this.released = new Set();
  }

  async get(confirmation) {
    return this.bookings.get(confirmation) ?? null;
  }

  async put(record) {
    this.bookings.set(record.confirmation, { ...record });
  }

  async active({ fromDate, toDate } = {}) {
    return [...this.bookings.values()].filter(
      (b) => b.status === 'active' && (!fromDate || b.date >= fromDate) && (!toDate || b.date <= toDate),
    );
  }

  async takenTables(date, sitting) {
    const taken = new Set();
    for (const b of this.bookings.values()) {
      if (b.status === 'active' && b.date === date && b.sitting === sitting) taken.add(b.table);
    }
    return taken;
  }

  async markReleased(key) {
    this.released.add(key);
  }

  async releasedKeys() {
    return new Set(this.released);
  }
}
