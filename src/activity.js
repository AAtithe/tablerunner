// Audit trail of everything the service did, newest first. Gives the GM and
// the sync owner a single place to see what happened to a booking and when.

export class ActivityLog {
  constructor({ limit = 500, clock } = {}) {
    this.items = [];
    this.limit = limit;
    this.clock = clock;
    this.seq = 0;
  }

  add(kind, message, detail = {}) {
    const item = { id: ++this.seq, at: this.clock(), kind, message, detail };
    this.items.unshift(item);
    if (this.items.length > this.limit) this.items.length = this.limit;
    return item;
  }

  list({ limit = 100 } = {}) {
    return this.items.slice(0, limit);
  }
}
