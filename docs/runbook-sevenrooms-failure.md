# Runbook: when the SevenRooms sync fails

For the host on shift and the sync owner at Broadcaster. It applies once
SevenRooms is live. In shadow mode nothing is written to SevenRooms, so hosts
keep working exactly as they do today and none of this is needed.

The rule behind every step: a guest with an OpenTable booking always has a
table. If the system cannot place them, a person does, straight away, and the
system is fixed afterwards.

## Who does what

Everyone signs in with their own account: their email address and a password
only they know. Accounts are never shared. What a person can do depends on
the role an admin gives their account.

| Job | Who | Table Runner role | Can do |
| --- | --- | --- | --- |
| Host on shift | Duty host | Manager | See the dashboard, acknowledge alerts, run releases and reconciliation |
| Duty manager | GM or assistant manager on shift | Manager | As the host. Final call on seating |
| GM | [Name], Broadcaster | Client admin for Broadcaster | As a manager, plus Settings: can switch to shadow mode if the sync owner cannot be reached |
| Sync owner | [Name], Williams, Stanley & Co. | Admin | Everything, including Settings and switching to shadow mode |
| Back-up sync owner | [Name], Williams, Stanley & Co. | Admin | As the sync owner |

A viewer account sees everything but cannot acknowledge an alert. Nobody on
shift should have one.

Contact numbers: [sync owner mobile], [back-up mobile], [GM mobile]. The sync
owner answers during service hours from 11:30 to 23:30.

At the host stand, sign out at the end of each shift. Every alert you
acknowledge is recorded with your name, so a sign-in left open puts your name
on someone else's actions.

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
4. Tell the duty manager who sold the protected table, if known, for the
   next day's review. Acknowledge the alert.

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
3. If you cannot sign in at all, use Forgotten your password? on the sign-in
   screen. If that does not work in two minutes, stop trying and carry on by
   hand: the duty manager or GM can check the dashboard on their own account.
4. Keep a list of what you entered by hand during the outage, with
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

The sync owner does this. If neither the sync owner nor the back-up answers
within 10 minutes during service, the GM does it on their client admin
account, then keeps trying the sync owner.

1. Sign in with your own account. If the site selector at the top shows more
   than one site, choose Broadcaster.
2. Open Settings. Under SevenRooms, set Mode to "Shadow: record only,
   SevenRooms untouched". Save.
3. Tell the duty manager: from now on, every OpenTable booking, change and
   cancellation is entered in SevenRooms by hand.

The change is recorded with your name and the time in the site's activity
and on the Admin panel's recent changes. Use that record for the times in the
incident write-up.

While in shadow mode, changes and cancellations to bookings that the sync
already wrote to SevenRooms raise `sync_failed`, because the shadow store does
not hold them. That is expected. Each one must still be made by hand.

### Switching back to live

1. Confirm the cause is fixed. If SevenRooms was down, they need to confirm
   it is back. If the sync was writing wrong data, the fix must be deployed and
   the contract tests must pass against the sandbox.
2. Sign in with your own account, choose Broadcaster, and set Mode back to
   live in Settings. Only the sync owner or back-up switches back to live,
   never the GM alone: going live again needs the cause confirmed as fixed.
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
- which bookings were handled by hand, by confirmation number, and who
  handled each: the site's activity shows who acknowledged every alert;
- whether any guest was affected, and how;
- the cause, and what changes so it does not happen again.

Count `table_taken` alerts each week. Any number above zero means protected
tables are being sold, and is raised with the GM.

## Before go-live

- Fill in the names and numbers above.
- Check accounts on the Admin panel, Users tab: every host and duty manager
  has their own manager account and has accepted the invite; the GM is a
  client admin for Broadcaster; the sync owner and back-up are admins. No
  host has a viewer account.
- Each host signs in once at the host stand device and resets a forgotten
  password, so the first time is not mid-service.
- Walk every host through this runbook once, with the dashboard open.
- Test the switch to shadow mode and back on the sandbox, with the GM
  watching.
- Print the host section and keep it at the host stand.
