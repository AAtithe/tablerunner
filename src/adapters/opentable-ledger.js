// OpenTable's view of bookings, built only from what OpenTable sent us
// (emails now, partner API later). Kept separate from the sync ledger so the
// morning reconciliation compares two independent records, not one with itself.

export class OpenTableLedger {
  constructor() {
    this.bookings = new Map();
  }

  record(event) {
    if (event.type === 'cancelled') {
      const b = this.bookings.get(event.confirmation);
      if (b) b.status = 'cancelled';
      return;
    }
    this.bookings.set(event.confirmation, {
      confirmation: event.confirmation,
      date: event.date,
      time: event.time,
      partySize: event.partySize,
      status: 'active',
    });
  }

  async listBookings({ fromDate, toDate }) {
    return [...this.bookings.values()].filter((b) => b.date >= fromDate && b.date <= toDate);
  }
}
