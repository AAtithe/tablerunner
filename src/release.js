import { releasesDue } from './allocation.js';

// Hands unsold OpenTable tables back to SevenRooms once their release time has
// passed. If SevenRooms cannot release by API, `manual: true` sends the list
// to the host as a checklist instead.
//
// OpenTable gives us no way to close a table, so a released table stays
// bookable there until a host closes it by hand. The reserve held back by
// `release.holdBack` takes any late OpenTable booking meanwhile; the sync
// alerts when it runs out. With an adapter that can close tables, it is used.
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
      severity: 'medium',
      code: 'close_in_opentable',
      message: `${due.length} table(s) released to SevenRooms are still bookable in OpenTable. Close them in OpenTable when you can and mark them closed in Table Runner. Until then the reserve covers late OpenTable bookings; Table Runner alerts if it runs out.`,
      tables: due.map(({ date, sitting, table }) => ({ date, sitting, table })),
    });
  }
  for (const slot of due) await store.markReleased(slot.key, now);
  return due;
}
