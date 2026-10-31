// Booking ledger keyed by OpenTable confirmation number. It makes the sync
// idempotent and records which protected table each booking holds.
// In-memory implementation; swap for the production store behind the same API.

export class MemoryStore {
  constructor() {
    this.bookings = new Map();
    this.released = new Set();
    this.closed = new Set();
    this.times = { released: new Map(), closed: new Map() };
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

  async markReleased(key, at = null) {
    this.released.add(key);
    if (at && !this.times.released.has(key)) this.times.released.set(key, at);
  }

  async releasedKeys() {
    return new Set(this.released);
  }

  // Released tables a host has confirmed closed in OpenTable by hand.
  async markClosedInOpenTable(key, at = null) {
    this.closed.add(key);
    if (at && !this.times.closed.has(key)) this.times.closed.set(key, at);
  }

  // When each table was released, and when a host confirmed it closed in
  // OpenTable. The coaching section measures the gap.
  async eventTimes() {
    return { released: new Map(this.times.released), closed: new Map(this.times.closed) };
  }

  async closedInOpenTableKeys() {
    return new Set(this.closed);
  }

  async all({ fromDate, toDate } = {}) {
    return [...this.bookings.values()].filter((b) => (!fromDate || b.date >= fromDate) && (!toDate || b.date <= toDate));
  }
}

// Small key/value state the dashboard reads (last email, last reconciliation).
export class MemoryState {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
  }
}

// Serialises occupancy changes within one process. Redis provides the
// cross-instance equivalent on Vercel.
export class MemoryLock {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(fn) {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}
