// SevenRooms adapter contract (tested in test/sevenrooms-contract.js):
//   createReservation(reservation) -> sevenRoomsId
//   updateReservation(sevenRoomsId, reservation)
//   cancelReservation(sevenRoomsId)
//   listReservations({ fromDate, toDate }) -> [{ externalRef, source, status, date, time, partySize, table }]
//   releaseTable({ date, sitting, table })
//
// A reservation is { date, time, partySize, table, sitting, guest, notes,
// source, externalRef }. Status is 'active' or 'cancelled'. Create and update
// reject with TableTakenError when another active reservation holds the same
// table in the same sitting, and change nothing. Update and cancel of an
// unknown id reject.

export class TableTakenError extends Error {
  constructor({ date, sitting, table }) {
    super(`table ${table} is already taken on ${date} (${sitting})`);
    this.code = 'table_taken';
    this.slot = { date, sitting, table };
  }
}

// Throws if `r` would put a second party on a table. `all` is every stored
// reservation; `selfId` is the one being updated, if any.
export function assertTableFree(all, r, selfId) {
  const clash = all.find((x) => x.id !== selfId && x.status === 'active'
    && x.date === r.date && x.sitting === r.sitting && x.table === r.table);
  if (clash) throw new TableTakenError(r);
}

// Test double. Also used for the parallel run before go-live.
export class MemorySevenRooms {
  constructor() {
    this.reservations = new Map();
    this.releases = [];
    this.seq = 0;
  }

  async createReservation(r) {
    assertTableFree([...this.reservations.values()], r);
    const id = `sr_${++this.seq}`;
    this.reservations.set(id, { ...r, id, status: 'active' });
    return id;
  }

  async updateReservation(id, r) {
    if (!this.reservations.has(id)) throw new Error(`unknown reservation ${id}`);
    const next = { ...this.reservations.get(id), ...r };
    assertTableFree([...this.reservations.values()], next, id);
    this.reservations.set(id, next);
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
