import { releasesDue } from './allocation.js';

// Hands unsold OpenTable tables back to SevenRooms once their release time has
// passed. If SevenRooms cannot release by API, `manual: true` sends the list
// to the host as a checklist instead.
export async function runReleases({ config, store, sevenRooms, alert, now, fromDate, toDate, manual = false }) {
  const released = await store.releasedKeys();
  // Pre-load occupancy so releasesDue can stay synchronous.
  const occupiedCache = new Map();
  const occupied = (date, sitting) => occupiedCache.get(`${date}|${sitting}`) ?? new Set();
  for (const b of await store.active({ fromDate, toDate })) {
    const key = `${b.date}|${b.sitting}`;
    if (!occupiedCache.has(key)) occupiedCache.set(key, new Set());
    occupiedCache.get(key).add(b.table);
  }

  const due = releasesDue(config, { now, fromDate, toDate, occupied, released });
  if (due.length === 0) return [];

  if (manual) {
    await alert.send({
      severity: 'medium',
      code: 'manual_release_due',
      message: `Release ${due.length} unsold OpenTable table(s) in SevenRooms now.`,
      tables: due.map(({ date, sitting, table }) => ({ date, sitting, table })),
    });
  } else {
    for (const slot of due) await sevenRooms.releaseTable(slot);
  }
  for (const slot of due) await store.markReleased(slot.key);
  return due;
}
