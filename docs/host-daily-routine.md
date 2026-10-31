# Table Runner: host daily routine

Last updated 31 October 2026. Background for managers and the sync owner is in
[opentable-exposure.md](opentable-exposure.md).

## Why this routine matters

Your job in this routine is simple: no guest arrives to find their table given to someone else. Table Runner does most of the work, but there is one thing it cannot do, and that is where you come in.

OpenTable sells only the tables we protect for it, called the allocation. Two days before service, at 16:00, any OpenTable table still unsold is handed back to SevenRooms so we can sell it ourselves. This is called the release.

Table Runner cannot close those tables in OpenTable. Until you close them by hand, OpenTable can still sell them, even after SevenRooms has sold them to someone else. That is how a double booking happens.

Two things protect us:

- The reserve. At release, Table Runner keeps one or two unsold OpenTable tables back. Any late OpenTable booking goes onto a reserve table, never onto a released one.
- You. You close released tables in OpenTable, and you act fast when Table Runner says the reserve has run out.

Example: on Friday late we keep two tables in reserve. A late OpenTable booking takes one, then another. The reserve is now empty, and Table Runner sends a red alert. You stop online sales for Friday late in OpenTable straight away. Without that step, the next OpenTable booking could land on a table we have already sold.

## Before you start

Sign in to Table Runner with the team password. Your manager gives you the address. You stay signed in for 12 hours. After ten wrong passwords the device is locked out for 15 minutes.

The screen has five parts, top to bottom:

1. Status tiles. The one to watch is Open in OpenTable. Green is fine, amber means released tables are still open in OpenTable, red means a sitting has no reserve left.
2. Service day. Pick a date to see every protected OpenTable table for each sitting.
3. Open alerts, on the right. Anything that needs a person.
4. Next 7 days. Tables sold per sitting, plus a row counting tables still open in OpenTable. A red cell means a sitting is at risk.
5. Coaching and activity. For the weekly review with your manager.

What the table cards mean:

| Card | Status | What it means for you |
| --- | --- | --- |
| Blue | Sold | An OpenTable guest is booked on it. Nothing to do. |
| Plain, thin border | Open | Before release. Held for OpenTable. Do not sell it in SevenRooms. |
| Green outline | Reserve | After release. Held for late OpenTable bookings. Do not sell it in SevenRooms. |
| Amber, dashed | Released, still open in OpenTable | Ours to sell in SevenRooms, but OpenTable can still sell it too. Close it in OpenTable. |
| Grey, dashed | Released, closed in OpenTable | Ours to sell in SevenRooms. Nothing to do. |

While Table Runner runs in shadow mode, a banner says so at the top. In shadow mode nothing is written to SevenRooms. Keep entering OpenTable bookings in SevenRooms exactly as you do today, and release tables in SevenRooms by hand when Table Runner asks.

## Morning check, before service

Ten minutes, done by the first host in, before the doors open. Table Runner compares OpenTable with SevenRooms every morning before you arrive, so most days this is a quick look.

1. Open Table Runner and look at the Open in OpenTable tile.
    - Red: go straight to step 3 for the sitting it names. That comes first.
    - Amber or green: carry on.
2. Check the Reconciliation tile.
    - Clean: nothing to do.
    - Issues: open the Reconciliation mismatch alert. Each line names an OpenTable confirmation number and what is wrong. Fix each one in SevenRooms so it matches OpenTable, then press Acknowledge.
3. Look at today and tomorrow in the Next 7 days grid, on the Open in OpenTable row.
    - Any number above zero: those released tables are still bookable in OpenTable. Close them in OpenTable (see the next section), then press Mark closed in OpenTable on the Service day screen for that sitting.
4. Read every open alert, oldest first. Do what it says, then press Acknowledge. Never acknowledge an alert you have not acted on.
5. Open today on the Service day screen. Check the sold tables match the bookings you can see in SevenRooms, and that no green reserve table or open table has been sold to a walk-in or a direct booking.

What the reconciliation catches: an OpenTable booking missing from SevenRooms, a time or party size that differs, or a booking in SevenRooms marked as OpenTable that OpenTable has cancelled. Each of these is a guest who will arrive to the wrong information if it is not fixed before service.

## At release time, 16:00

Every day at 16:00 Table Runner releases the unsold OpenTable tables for the service two days ahead. It runs a few minutes past the hour. At 16:00 on Wednesday, Friday's tables are released.

The release puts a Close in OpenTable alert on the dashboard, listing each table by date, sitting and table number. Deal with it within two hours. That is the target the coaching measures.

1. While Table Runner is in shadow mode, you will also see a Manual release due alert. Open those tables for sale in SevenRooms first, then acknowledge it.
2. Open OpenTable and close each table on the Close in OpenTable list for that date and sitting.
    - If the sitting is nearly full anyway, it is quicker and safer to stop online sales for the whole sitting.
3. Back in Table Runner, open that date on the Service day screen.
4. Press Mark closed in OpenTable for each sitting you closed. The amber cards turn grey and the Open in OpenTable count drops.
5. Acknowledge the Close in OpenTable alert.

Mark closed in OpenTable only records what you did. It does not change anything in OpenTable. Press it only after the tables are actually closed there, or the dashboard will show the sitting as safe when it is not.

Why two hours matters: OpenTable can sell a released table from the moment it is released. The reserve covers the gap, but only for as many late bookings as it has tables. Closing quickly means the reserve rarely gets tested.

## During service: answering alerts

One named host owns alerts each shift. Check the dashboard at least every 30 minutes, and straight away when an alert comes through on the team channel. Red alerts are answered within 30 minutes; that is the coaching target.

Red alerts mean a guest is at risk. Act now.

| Alert | What happened | What you do |
| --- | --- | --- |
| Reserve exhausted | A late OpenTable booking took the last reserve table, and released tables are still open in OpenTable | Stop online sales for that sitting in OpenTable now. Then Mark closed in OpenTable and acknowledge. |
| Over allocation | An OpenTable booking has no protected table to go on | Find the guest a table in SevenRooms by hand. If the alert says released tables are still open there, OpenTable has oversold: check SevenRooms for a clash, call the guest if needed, and stop online sales for the sitting. Tell your manager. |
| Outside sittings | An OpenTable booking is at a time outside our sittings | Check the time with the guest or OpenTable and seat by hand. Tell your manager. |
| Unparseable email | Table Runner could not read an OpenTable email | Enter that booking in SevenRooms by hand from OpenTable. Forward the email to the sync owner. |
| Sync failed | A booking did not reach SevenRooms | Enter or update it in SevenRooms by hand. Tell the sync owner if it repeats. |
| Reconciliation mismatch | OpenTable and SevenRooms disagree | Correct SevenRooms to match OpenTable for each line listed. |

Amber alerts need action today, not this minute.

| Alert | What happened | What you do |
| --- | --- | --- |
| Close in OpenTable | Tables were released to SevenRooms | Close them in OpenTable within two hours, then Mark closed in OpenTable. |
| Manual release due | Shadow mode only: tables are due back in SevenRooms | Open them for sale in SevenRooms. |
| Reserve used | A late OpenTable booking went on a reserve table | Nothing urgent. Note how many reserve tables are left. If tables are still open in OpenTable, close them now so the reserve is not needed again. |
| Cancel unknown | OpenTable cancelled a booking Table Runner never saw | Find it in SevenRooms and cancel it by hand if it is there. |

Acknowledge an alert only once you have done what it asks. The time from alert to acknowledge is how the team's response is measured.

## End of shift handover

Before you leave, tick these off. The next host should never inherit a problem they do not know about.

- [ ] No red alerts left open
- [ ] Any amber alert still open is named to the incoming host, with what has been done so far
- [ ] Open in OpenTable is zero for today and tomorrow, or the incoming host knows which sittings are still open
- [ ] Any booking seated or entered by hand today is noted for your manager
- [ ] The incoming host knows they now own alerts

## Weekly: coaching review with your manager

Fifteen minutes, once a week, with the Coaching section open. It measures the team, not individuals, because everyone shares one login. The point is to get a little better every week, not to find someone to blame.

The habits we track, and the targets:

| Habit | Target |
| --- | --- |
| Released tables closed in OpenTable before service | At least 90% |
| Time from release to closing in OpenTable | Under 2 hours |
| Red alerts answered within 30 minutes | At least 90% |
| Reserve ran out | No more than once a month |
| OpenTable oversold | Zero |
| Unreadable OpenTable emails | Zero |

How to run it:

1. Read the coaching notes. Red is improve now, amber is worth a look, green is on target.
2. Pick the one red note that matters most. Only one.
3. Agree one habit that would fix it, and who does it. Example: closing tables in OpenTable is at 70%, so the host on at 16:00 closes them before their break.
4. Next week, check that row in Team habits, week by week. Did it move?
5. Leave reserve sizes and the allocation to your manager. The model suggests them; your manager decides and changes them on Settings.

## Quick reference

Print this and keep it at the host stand.

| When | Do this |
| --- | --- |
| Doors open | Check Open in OpenTable and Reconciliation. Clear every open alert. |
| 16:00 | Close released tables in OpenTable within two hours, then Mark closed in OpenTable. |
| Any red alert | Act within 30 minutes. Reserve exhausted means stop online sales for that sitting now. |
| End of shift | Tick the handover list. Hand over alert ownership. |
| Weekly | Coaching review: one red note, one habit, check it next week. |

Common mistakes:

- Pressing Mark closed in OpenTable before closing the tables in OpenTable. The dashboard then shows a sitting as safe when it is not.
- Selling a green reserve table or a plain open table in SevenRooms, to a walk-in or a direct booking. Those tables are held for OpenTable until service.
- Acknowledging an alert to clear the screen. Acknowledge means done.
- Waiting for the reserve to run out before closing tables. The reserve is the safety net, not the plan.
- Fixing a reconciliation mismatch in OpenTable instead of SevenRooms. OpenTable is the guest's confirmation; SevenRooms is corrected to match it.
