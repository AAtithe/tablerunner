// SevenRooms adapter contract:
//   createReservation(reservation) -> sevenRoomsId
//   updateReservation(sevenRoomsId, reservation)
//   cancelReservation(sevenRoomsId)
//   listReservations({ fromDate, toDate }) -> [{ externalRef, source, status, date, time, partySize }]
//   releaseTable({ date, sitting, table })

// Test double. Also used for the parallel run before go-live.
export class MemorySevenRooms {
  constructor() {
    this.reservations = new Map();
    this.releases = [];
    this.seq = 0;
  }

  async createReservation(r) {
    const id = `sr_${++this.seq}`;
    this.reservations.set(id, { ...r, id, status: 'active' });
    return id;
  }

  async updateReservation(id, r) {
    if (!this.reservations.has(id)) throw new Error(`unknown reservation ${id}`);
    this.reservations.set(id, { ...this.reservations.get(id), ...r });
  }

  async cancelReservation(id) {
    if (!this.reservations.has(id)) throw new Error(`unknown reservation ${id}`);
    this.reservations.get(id).status = 'cancelled';
  }

  async listReservations({ fromDate, toDate }) {
    return [...this.reservations.values()].filter((r) => r.date >= fromDate && r.date <= toDate);
  }

  async releaseTable(slot) {
    this.releases.push(slot);
  }
}

// Live client. Blocked on venue API credentials and SevenRooms' API
// documentation, both issued through the account manager. Endpoints are not
// written from memory; they will be implemented against the issued docs.
export class SevenRoomsClient {
  // Flipped to true when the endpoints are written against the issued docs.
  // Until then the Settings screen refuses to switch SevenRooms to live.
  static implemented = false;

  constructor({ clientId, clientSecret, venueId, baseUrl } = {}) {
    this.settings = { clientId, clientSecret, venueId, baseUrl };
  }

  #blocked() {
    throw new Error('SevenRooms live client not implemented: awaiting API credentials and documentation');
  }

  async createReservation() { this.#blocked(); }
  async updateReservation() { this.#blocked(); }
  async cancelReservation() { this.#blocked(); }
  async listReservations() { this.#blocked(); }
  async releaseTable() { this.#blocked(); }
}
