// Protected OpenTable allocation. SevenRooms owns every table; OpenTable may
// only occupy the tables listed for that weekday and sitting. Bookings land on
// tables nobody else can sell, so sync latency cannot cause a double booking.

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function weekday(date) {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
}

export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function sittingFor(config, time) {
  return config.sittings.find((s) => time >= s.start && time < s.end) ?? null;
}

export function allocatedTables(config, date, sittingName) {
  const plan = config.openTable[weekday(date)] ?? config.openTable.default;
  return plan?.[sittingName] ?? [];
}

// Returns the smallest free allocated table that seats the party, or a reason
// why the booking cannot be placed. `taken` is the set of table ids already
// holding an OpenTable booking for that date and sitting.
export function assignTable(config, { date, time, partySize }, taken) {
  const sitting = sittingFor(config, time);
  if (!sitting) return { ok: false, reason: 'outside_sittings' };

  const candidates = allocatedTables(config, date, sitting.name)
    .filter((id) => !taken.has(id))
    .map((id) => ({ id, seats: config.tables[id]?.seats ?? 0 }))
    .filter((t) => t.seats >= partySize)
    .sort((a, b) => a.seats - b.seats);

  if (candidates.length === 0) return { ok: false, reason: 'over_allocation', sitting: sitting.name };
  return { ok: true, table: candidates[0].id, sitting: sitting.name };
}

export function releaseAt(config, serviceDate) {
  return `${addDays(serviceDate, -config.release.daysBefore)}T${config.release.time}`;
}

// Unsold OpenTable tables kept back from each release as a reserve, per
// sitting. OpenTable has no way for us to close a table, so a released table
// stays bookable there. A late OpenTable booking is placed on a reserve table
// instead, and only when the reserve is gone can OpenTable double-book a
// table SevenRooms has resold. `release.holdBack` is a number for every
// sitting, or { default, <sitting>: n, <weekday>: { <sitting>: n } }.
export function holdBackFor(config, date, sittingName) {
  const h = config.release?.holdBack;
  if (h == null) return 0;
  if (typeof h === 'number') return h;
  const day = h[weekday(date)];
  if (typeof day === 'number') return day;
  if (day && typeof day[sittingName] === 'number') return day[sittingName];
  if (typeof h[sittingName] === 'number') return h[sittingName];
  return typeof h.default === 'number' ? h.default : 0;
}

// Which unsold tables to keep as the reserve: the largest first, because a
// four-top can take a late two but a two-top cannot take a late four.
export function pickReserve(config, unsold, count) {
  return [...unsold]
    .sort((a, b) => (config.tables[b]?.seats ?? 0) - (config.tables[a]?.seats ?? 0) || a.localeCompare(b))
    .slice(0, Math.max(0, count));
}

// Lists allocated tables still unsold whose release time has passed, for every
// service date in [fromDate, toDate], less the reserve held back for late
// OpenTable bookings. `now` is London local time as YYYY-MM-DDTHH:MM.
// `occupied(date, sitting)` returns the taken table ids.
export function releasesDue(config, { now, fromDate, toDate, occupied, released = new Set() }) {
  const due = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    if (now < releaseAt(config, date)) continue;
    for (const sitting of config.sittings) {
      const taken = occupied(date, sitting.name);
      const unsold = allocatedTables(config, date, sitting.name)
        .filter((t) => !taken.has(t) && !released.has(`${date}|${sitting.name}|${t}`));
      const reserve = new Set(pickReserve(config, unsold, holdBackFor(config, date, sitting.name)));
      for (const table of unsold) {
        if (!reserve.has(table)) due.push({ date, sitting: sitting.name, table, key: `${date}|${sitting.name}|${table}` });
      }
    }
  }
  return due;
}

// Where one sitting stands once its release time has passed. `exposed` are
// released tables not yet confirmed closed in OpenTable; `reserve` are unsold
// tables still held for OpenTable. Exposure is covered while a reserve table
// can take the party; with no reserve left, any exposed table is a live
// double-booking risk.
export function exposureFor(config, { date, sitting, taken, released, closed }) {
  const allocated = allocatedTables(config, date, sitting);
  const isReleased = (t) => released.has(`${date}|${sitting}|${t}`);
  const exposed = allocated.filter((t) => isReleased(t) && !closed.has(`${date}|${sitting}|${t}`));
  const reserve = allocated.filter((t) => !taken.has(t) && !isReleased(t));
  const largestReserve = Math.max(0, ...reserve.map((t) => config.tables[t]?.seats ?? 0));
  return { exposed, reserve, largestReserve, atRisk: exposed.length > 0 && reserve.length === 0 };
}
