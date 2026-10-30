import { releasesDue } from './allocation.js';

// Hands unsold OpenTable tables back to SevenRooms once their release time has
// passed. If SevenRooms cannot release by API, `manual: true` sends the list
// to the host as a checklist instead.
//
// A release is two-sided: the table must also stop selling on OpenTable, or
// OpenTable can book it after SevenRooms has resold it. Without an OpenTable
// adapter that can close tables, the host is told to close them by hand.
export async function runReleases({ config, store, sevenRooms, openTable, alert, now, fromDate, toDate, manual = false }) {
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

  if (openTable?.closeTable) {
    for (const slot of due) await openTable.closeTable(slot);
  } else {
    await alert.send({
      severity: 'high',
      code: 'close_in_opentable',
      message: `Close ${due.length} released table(s) in OpenTable now, or OpenTable can still sell them.`,
      tables: due.map(({ date, sitting, table }) => ({ date, sitting, table })),
    });
  }
  for (const slot of due) await store.markReleased(slot.key);
  return due;
}
