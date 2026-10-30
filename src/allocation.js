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

// Lists allocated tables still unsold whose release time has passed, for every
// service date in [fromDate, toDate]. `now` is London local time as
// YYYY-MM-DDTHH:MM. `occupied(date, sitting)` returns the taken table ids.
export function releasesDue(config, { now, fromDate, toDate, occupied, released = new Set() }) {
  const due = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    if (now < releaseAt(config, date)) continue;
    for (const sitting of config.sittings) {
      const taken = occupied(date, sitting.name);
      for (const table of allocatedTables(config, date, sitting.name)) {
        const key = `${date}|${sitting.name}|${table}`;
        if (!taken.has(table) && !released.has(key)) due.push({ date, sitting: sitting.name, table, key });
      }
    }
  }
  return due;
}
