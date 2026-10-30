// Morning check: every OpenTable booking for the window must exist in
// SevenRooms with the same date, time and party size, and nothing tagged as
// OpenTable may exist in SevenRooms without a live OpenTable booking. This is
// the net that catches a sync that has failed silently.

export function reconcile({ openTable, sevenRooms }) {
  const issues = [];
  const srByRef = new Map(
    sevenRooms.filter((r) => r.source === 'opentable' && r.status !== 'cancelled').map((r) => [r.externalRef, r]),
  );

  for (const ot of openTable.filter((b) => b.status !== 'cancelled')) {
    const sr = srByRef.get(ot.confirmation);
    if (!sr) {
      issues.push({ code: 'missing_in_sevenrooms', confirmation: ot.confirmation, date: ot.date, time: ot.time });
      continue;
    }
    srByRef.delete(ot.confirmation);
    for (const field of ['date', 'time', 'partySize']) {
      if (ot[field] !== sr[field]) {
        issues.push({ code: 'field_mismatch', confirmation: ot.confirmation, field, openTable: ot[field], sevenRooms: sr[field] });
      }
    }
  }

  for (const sr of srByRef.values()) {
    issues.push({ code: 'orphan_in_sevenrooms', confirmation: sr.externalRef, date: sr.date, time: sr.time });
  }
  return issues;
}

export async function runReconciliation({ openTableSource, sevenRooms, alert, fromDate, toDate }) {
  const [ot, sr] = await Promise.all([
    openTableSource.listBookings({ fromDate, toDate }),
    sevenRooms.listReservations({ fromDate, toDate }),
  ]);
  const issues = reconcile({ openTable: ot, sevenRooms: sr });
  if (issues.length > 0) {
    await alert.send({
      severity: 'high',
      code: 'reconciliation_mismatch',
      message: `${issues.length} OpenTable/SevenRooms mismatch(es) for ${fromDate} to ${toDate}. Resolve before service.`,
      issues,
    });
  }
  return issues;
}
