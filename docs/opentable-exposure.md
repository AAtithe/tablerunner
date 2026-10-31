# Released tables left open in OpenTable

## The constraint

Table Runner cannot close a table in OpenTable. OpenTable reaches us only
through forwarded notification emails, which are read-only, and we have no
partner API access that writes availability. A table released to SevenRooms
therefore stays bookable on OpenTable until a host closes it by hand in
OpenTable.

That gap creates a risk. Once SevenRooms has resold a released table,
OpenTable can still sell it. If no protected table is left to put that party
on, two parties end up competing for one table.

## The control: a reserve, not a race

We do not rely on hosts closing every released table in OpenTable quickly.
At release time Table Runner keeps a small reserve of unsold OpenTable tables
back from SevenRooms (`release.holdBack`). Any OpenTable booking that arrives
after release goes onto a reserve table. A late booking is never placed on a
released table.

Three states matter for each sitting after its release time:

| State | Meaning | Risk |
| --- | --- | --- |
| Reserve | Unsold, still protected for OpenTable | None. OpenTable can sell it safely |
| Released, still open in OpenTable | Sellable in SevenRooms and still bookable in OpenTable | Covered while a reserve table remains |
| Released, closed in OpenTable | A host closed it and marked it closed in Table Runner | None |

So how many released tables can stay open in OpenTable? Any number, as long as
the reserve can take the late OpenTable bookings that actually arrive. The
number to manage is the size of the reserve, not the count of open tables.
The risk only becomes live when the reserve reaches zero while released
tables are still open in OpenTable.

Example, Friday late sitting with 4 OpenTable tables (two 2-tops, two 4-tops)
and `holdBack` of 1:

- At release, two tables are sold. Table Runner keeps the 4-top back as the
  reserve and releases the 2-top. One table is now open in OpenTable but sold
  in SevenRooms.
- At 18:40 OpenTable books a late two. It goes on the reserve 4-top. The
  reserve is now zero with one released table still open: Table Runner raises
  a high alert, "reserve exhausted".
- The host stops online sales for that sitting in OpenTable and presses "Mark
  closed in OpenTable" on the dashboard. Exposure drops to zero.

The reserve keeps the largest unsold tables first, because a 4-top can take a
late two but a 2-top cannot take a late four. The cost is a few seats held back
from SevenRooms; that is the price of not being able to close OpenTable.

## Setting the reserve

`release.holdBack` in the floor plan, on the Settings screen:

```json
"release": {
  "daysBefore": 2,
  "time": "16:00",
  "holdBack": { "default": 1, "late": 2, "sat": { "late": 3 } }
}
```

A plain number applies to every sitting. Otherwise a weekday entry wins, then
a sitting entry, then `default`.

Size it from evidence, not instinct. The dashboard's "Reserve sizing" panel
counts, for each weekday and sitting over the last 8 weeks, how many OpenTable
bookings arrived after release time on each night:

- 90% of nights: set `holdBack` to this. The reserve then covers nine nights in ten.
- Covered: the share of past nights the current reserve would have absorbed.
  Below 90%, raise it. At 100% with an average near zero, lower it and
  release more seats to SevenRooms.
- Worst night: the size of the occasional spike. Those nights are what the
  alerts and the manual close exist for.

Start with 1 per sitting and 2 on Friday and Saturday late until 4 to 6 weeks
of data exist, then set it from the panel and review it monthly alongside the
allocation itself. A later release time (fewer `daysBefore`) also shrinks late
demand, because fewer bookings arrive after release.

## Monitoring

Table Runner watches this continuously; hosts act on what it raises.

| Signal | Where | Action |
| --- | --- | --- |
| `close_in_opentable` (medium) | Alerts, after each release | Close the listed tables in OpenTable when convenient, then "Mark closed in OpenTable" |
| `reserve_used` (medium) | Alerts, on each late OpenTable booking | None needed; it shows reserve left and tables still open |
| `reserve_exhausted` (high) | Alerts and webhook | Stop online sales for that sitting in OpenTable now, then mark closed |
| `over_allocation` with "still open there" (high) | Alerts and webhook | OpenTable has sold past the reserve. Check SevenRooms for a clash, seat by hand, stop online sales for the sitting |
| "Open in OpenTable" tile | Dashboard status row | Red names the sittings with no reserve left in the next 7 days |
| "Open in OpenTable" row | Next 7 days grid | Count of released tables still open per day; red cell means at risk |
| Table cards | Service day | Amber dashed: released, still open in OpenTable. Green outline: reserve |

Daily routine for the host, before service:

1. Check the "Open in OpenTable" tile. Red means act first.
2. Close today's and tomorrow's released tables in OpenTable, or stop online
   sales for any sitting that is effectively full, then press "Mark closed in
   OpenTable" for that sitting.
3. Clear the morning reconciliation alert; it is the net for anything missed.

"Mark closed in OpenTable" only records what the host has done. It does not
change OpenTable, so press it only after the tables are closed there.
