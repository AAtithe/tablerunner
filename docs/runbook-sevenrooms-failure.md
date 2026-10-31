# Runbook: when the SevenRooms sync fails

For the host on shift and the sync owner at Broadcaster. It applies once
SevenRooms is live. In shadow mode nothing is written to SevenRooms, so hosts
keep working exactly as they do today and none of this is needed.

The rule behind every step: a guest with an OpenTable booking always has a
table. If the system cannot place them, a person does, straight away, and the
system is fixed afterwards.

## Who does what

| Role | Who | Holds |
| --- | --- | --- |
| Host on shift | Duty host | Team password: dashboard and alerts |
| Duty manager | GM or assistant manager on shift | Final call on seating |
| Sync owner | [Name], Williams, Stanley & Co. | Admin password: Settings, switch to shadow mode |
| Back-up sync owner | [Name] | Admin password |

Contact numbers: [sync owner mobile], [back-up mobile]. The sync owner
answers during service hours from 11:30 to 23:30.

## During service: what the host does

Check the dashboard alerts at the start of each sitting and whenever the
alert channel posts. Every alert has a code. Find the code below.

### `sync_failed`: a booking did not reach SevenRooms

The alert names the OpenTable confirmation number, the guest and the time.

1. Open the booking in OpenTable using the confirmation number.
2. Enter it in SevenRooms by hand, on the table named in the alert if there is
   one, otherwise on any free protected OpenTable table in that sitting.
3. Put the OpenTable confirmation number in the SevenRooms notes.
4. Acknowledge the alert.
5. If three or more `sync_failed` alerts arrive within 30 minutes, SevenRooms
   or the connection is down. Phone the sync owner (see below) and enter every
   new OpenTable booking by hand until they confirm it is fixed.

### `table_taken`: SevenRooms refused the booking because the table is already sold

A protected OpenTable table has been sold another way, usually by a host or
the direct widget. Two parties now hold one table.

1. Tell the duty manager now. Do not wait for the guest to arrive.
2. Seat the OpenTable party on another table of the right size in the same
   sitting. If there is none, the duty manager decides who to move and calls
   the guest before they arrive.
3. Enter the OpenTable booking in SevenRooms by hand with its confirmation
   number in the notes.
4. Write in the alert who sold the protected table, if known. Acknowledge it.

Every `table_taken` alert is reviewed the next day. It means the protection
on OpenTable tables failed, which matters more than the single booking.

### `over_allocation` or `outside_sittings`: no protected table fits

OpenTable sold a party the allocation cannot seat, or a time outside the
sittings.

1. Seat the party by hand in SevenRooms like any other booking.
2. Acknowledge the alert. The sync owner reviews the allocation.

### `unparseable_email`: an OpenTable email could not be read

1. Open the booking in OpenTable using the subject line in the alert.
2. Enter it in SevenRooms by hand, or make the change or cancellation it
   describes.
3. Acknowledge the alert. Forward the original email to the sync owner.

### `manual_release_due` and `close_in_opentable`: release unsold tables

These arrive at the release time on each service day.

1. Open the tables listed in SevenRooms so they can be sold directly.
2. Close the same tables in OpenTable. Both steps are needed: a table open in
   both systems can be sold twice.
3. Acknowledge both alerts.

### The dashboard will not load

1. Work from OpenTable and SevenRooms directly, as before the sync. Enter each
   new OpenTable booking, change and cancellation in SevenRooms by hand.
2. Phone the sync owner.
3. Keep a list of what you entered by hand during the outage, with
   confirmation numbers. The sync owner needs it afterwards.

## Before service: the morning reconciliation

Reconciliation runs at 06:30 and compares the next seven days in OpenTable
with SevenRooms. A `reconciliation_mismatch` alert lists each problem.

| Issue | Meaning | Action before service |
| --- | --- | --- |
| `missing_in_sevenrooms` | OpenTable booking not in SevenRooms | Enter it by hand, with the confirmation number in the notes |
| `field_mismatch` | Date, time or party size differs | Correct SevenRooms to match OpenTable, unless the guest changed it by phone |
| `orphan_in_sevenrooms` | In SevenRooms, cancelled or absent in OpenTable | Check OpenTable. If cancelled there, cancel in SevenRooms |

The opening manager clears every mismatch for today before the first sitting.

## The sync owner

### Deciding whether to switch to shadow mode

Switch to shadow mode when either is true:

- three or more `sync_failed` alerts within 30 minutes, or SevenRooms
  confirms an outage;
- the sync is writing something wrong into SevenRooms, such as the wrong
  table, time or party size.

Do not switch for a single `table_taken`, `over_allocation` or
`unparseable_email` alert. Those mean the system is working and caught a
problem.

### Switching to shadow mode

1. Sign in to the dashboard with the admin password and open Settings.
2. Under SevenRooms, set Mode to "Shadow: record only, SevenRooms untouched".
   Save.
3. Tell the duty manager: from now on, every OpenTable booking, change and
   cancellation is entered in SevenRooms by hand.
4. Note the time of the switch.

While in shadow mode, changes and cancellations to bookings that the sync
already wrote to SevenRooms raise `sync_failed`, because the shadow store does
not hold them. That is expected. Each one must still be made by hand.

### Switching back to live

1. Confirm the cause is fixed. If SevenRooms was down, they need to confirm
   it is back. If the sync was writing wrong data, the fix must be deployed and
   the contract tests must pass against the sandbox.
2. Set Mode back to live in Settings.
3. Run reconciliation from the dashboard straight away.
4. Bookings that arrived during shadow mode were entered by hand, so they are
   not linked to the sync, and any later change or cancellation to one raises
   `sync_failed`. Give the host the list of those confirmation numbers: each
   stays a manual booking for its whole life, and its changes are made by
   hand.
5. Write up the incident (below).

### After any incident

Within one working day, record in this repository under `docs/incidents/`:

- what happened and when, from the first alert to the switch back;
- which bookings were handled by hand, by confirmation number;
- whether any guest was affected, and how;
- the cause, and what changes so it does not happen again.

Count `table_taken` alerts each week. Any number above zero means protected
tables are being sold, and is raised with the GM.

## Before go-live

- Fill in the names and numbers above.
- Walk every host through this runbook once, with the dashboard open.
- Test the switch to shadow mode and back on the sandbox, with the GM
  watching.
- Print the host section and keep it at the host stand.
