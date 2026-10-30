# openroomst

OpenTable to SevenRooms booking sync for Openhouse.

SevenRooms owns the floor plan. OpenTable sells only a protected allocation of
tables per weekday and sitting. Every OpenTable booking, change and
cancellation is written into SevenRooms against one of those protected tables,
so a delay in the sync can never put two parties on one table. Unsold
allocation is released back to SevenRooms at a fixed time before service, and
a morning reconciliation catches anything the sync missed.

## Components

| File | Purpose |
| --- | --- |
| `config/allocation.example.json` | Tables, sittings, OpenTable allocation per weekday and sitting, release rule |
| `src/allocation.js` | Table assignment within the allocation, release schedule |
| `src/sync.js` | Applies OpenTable created / modified / cancelled events to SevenRooms, idempotently |
| `src/release.js` | Releases unsold allocation, by API or as a host checklist (`manual: true`) |
| `src/reconcile.js` | Daily OpenTable vs SevenRooms comparison with alert |
| `src/adapters/opentable-email.js` | Parses OpenTable notification emails (fallback if no partner API) |
| `src/adapters/sevenrooms.js` | SevenRooms adapter contract, in-memory double, live client stub |
| `src/alert.js` | Alert sinks |
| `src/store.js` | Booking ledger keyed by OpenTable confirmation number |

## Status

Built and tested: allocation, assignment, sync logic, releases, reconciliation,
alerting, inbound email handling.

Blocked:

1. SevenRooms live client: needs venue API credentials and SevenRooms' API
   documentation from the account manager.
2. OpenTable email patterns: the current patterns are provisional. Replace them
   from 10 to 20 real confirmation, modification and cancellation emails.
3. OpenTable booking list for reconciliation: depends on partner API access, or
   on building the list from the synced emails if access is refused.
4. Allocation config: replace the example with the real floor plan and an
   allocation sized from last quarter's OpenTable covers.
5. Production store, scheduler and alert channel: choose at deployment.

## Rules that do not change

- Hosts and the direct widget never sell a protected OpenTable table.
- An email the parser cannot read raises an alert. It is never dropped.
- The allocation stays in force after go-live. The sync removes re-keying; it
  does not replace the allocation.

## Tests

```bash
npm test
```
