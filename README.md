# Table Runner

OpenTable to SevenRooms booking sync, first deployed for Broadcaster.

SevenRooms owns the floor plan. OpenTable sells only a protected allocation of
tables per weekday and sitting. Every OpenTable booking, change and
cancellation is written into SevenRooms against one of those protected tables,
so a delay in the sync can never put two parties on one table. Unsold
allocation is released back to SevenRooms at a fixed time before service, and
a morning reconciliation catches anything the sync missed.

## Components

| File | Purpose |
| --- | --- |
| `config/allocation.example.js` | Example tables, sittings, OpenTable allocation per weekday and sitting, release rule |
| `src/allocation.js` | Table assignment within the allocation, release schedule |
| `src/sync.js` | Applies OpenTable created / modified / cancelled events to SevenRooms, idempotently |
| `src/release.js` | Releases unsold allocation less the reserve, by API or as a host checklist (`manual: true`) |
| `src/coaching.js` | Learns late OpenTable demand and sell-through per night, measures team habits by week, writes coaching notes |
| `docs/host-daily-routine.md` | Host guide: morning check, release time, alerts, handover, weekly coaching review |
| `docs/opentable-exposure.md` | Why released tables stay open in OpenTable, sizing the reserve, monitoring |
| `src/reconcile.js` | Daily OpenTable vs SevenRooms comparison with alert |
| `src/adapters/opentable-email.js` | Parses OpenTable notification emails (fallback if no partner API) |
| `src/adapters/sevenrooms.js` | SevenRooms adapter contract, in-memory double, live client stub |
| `src/alert.js` | Alert sinks |
| `src/store.js` | Booking ledger keyed by OpenTable confirmation number |
| `src/adapters/opentable-ledger.js` | OpenTable's own record of bookings, kept apart so reconciliation compares two independent sources |
| `src/app.js` | Wires sync, releases, reconciliation, alerts and the activity log |
| `src/server.js`, `public/index.html` | Dashboard and JSON API |
| `scripts/demo.js` | Dashboard on synthetic data with in-memory vendors |
| `src/adapters/redis.js` | Redis storage, shadow SevenRooms and the cross-instance booking lock; Upstash REST client |
| `src/adapters/redis-tcp.js` | Direct Redis connection from `REDIS_URL` |
| `src/settings.js` | In-app settings, setup code, password hashing, sessions, floor plan validation |
| `src/directory.js` | Clients (groups), sites (one per venue: floor plan, SevenRooms, webhook key, Postmark) and users (role, client and site access) |
| `src/postmark.js` | Connects a Postmark server's inbound webhook to Table Runner |
| `src/mail.js` | Outbound email through Postmark: invite and password reset links, test email, message templates |
| `src/live.js`, `src/vercel.js`, `api/index.js` | Live service on Vercel: wiring from saved settings, authenticated API |
| `scripts/build-static.js` | Builds `dist/index.html` (live dashboard) and `dist/demo/index.html` (browser-only demo) |

## Dashboard

```bash
npm run demo
```

Open http://127.0.0.1:3000. It shows:

- Connection status: SevenRooms, OpenTable source, email parser, last reconciliation, open alerts.
- Each service day: every protected table by sitting, marked sold (guest, time, party, both booking references), open or released.
- Next 7 days: tables sold against allocation per sitting, used to size the allocation each month.
- Open alerts with acknowledge, and a full activity log.
- Coaching: learned reserve and allocation suggestions per night, team habits
  by week, and coaching notes with targets.
- Buttons to run reconciliation and releases on demand.

The local demo binds to localhost. `DASHBOARD_PASSWORD` adds a password if
you expose it on a network; the live service on Vercel does not use it.

API: `GET /api/status`, `GET /api/day?date=`, `GET /api/week?from=`,
`GET /api/alerts`, `GET /api/activity`, `GET /api/coaching`, `GET /api/late-demand?weeks=`,
`POST /api/reconcile`, `POST /api/release`, `POST /api/opentable-closed`, `POST /api/inbound-email`, `POST /api/alerts/:id/ack`.

## Live deployment (Vercel)

The live service runs as one Vercel function behind `/api`, with Redis for
storage: Upstash over its REST API when connected, otherwise any Redis
database through its `REDIS_URL`. The dashboard is at `/` and the browser-only demo at `/demo`.

All settings live in the app: users on the Users screen, clients and sites on
the Clients and sites screen, and per site on the Settings screen the
email webhook key, the alert channel, SevenRooms details and the floor plan.
There are no environment variables to set. The only connection outside the app
is the one to the database that holds those settings, and Vercel creates it
when a Redis database is connected.

Setup, once:

1. In Vercel, open the tablerunner project, choose Storage, and connect a
   Redis database (Upstash for Redis, or Redis). Redeploy.
2. Open the site. It asks for a setup code. The code is in the project's
   Vercel logs (search for "setup code"), which only the Vercel team can see.
   Enter it with your name, email and a password: you become the first
   admin. Add everyone else as named users on the Users screen.
3. Settings opens. In Postmark, create a server and copy its Server API
   token (server, API Tokens). Paste it under "OpenTable emails in" and choose
   Connect Postmark. Table Runner sets Postmark's inbound webhook itself and
   shows the forwarding address. Do this from the public address, not one
   behind Vercel's login; Table Runner refuses otherwise. Forward OpenTable
   notification emails to the address shown. A new webhook key re-points
   Postmark automatically.
4. Optionally add a Slack or Teams incoming webhook for alerts.
5. Paste the venue's real floor plan and allocation, and set `"example"` to
   `false`.

Until SevenRooms is switched to live, the service runs in shadow mode: every
OpenTable email is processed and shown with the table it would take, but
nothing is written to SevenRooms. The Settings screen refuses live mode until
the SevenRooms connection is built (`SevenRoomsClient.implemented`).

Admin panel (the Admin button, for admins and client admins) has five tabs:

- Overview: counts of clients, sites, users and invites, and a Needs attention
  list with a button for each item: email sending not set up, only one admin,
  a site with no Postmark connection or still on the example floor plan, an
  invite not yet accepted or expired. Recent changes underneath.
- Clients and sites, and Users: described below.
- Email (admins only): connect Postmark for sending, set the From address and
  name and the public address used in links, send yourself a test, and
  preview the invite and password reset emails exactly as they are sent.
- Admin log: every change and who made it, filtered by type and searchable.

Invites and password resets:

- Adding a user offers two ways in: email an invite (they choose their own
  password from a link), or set a password now and pass it on yourself.
- Links work once. Invite links expire after 7 days, reset links after 1
  hour. Redis holds only a hash of each link. Sending a new link, using one,
  or changing the user's email voids every earlier link for that user.
- An invite is emailed before the user is saved, so a Postmark refusal leaves
  nothing half created, and the error says what to fix in Postmark.
- Users table: Resend invite for invited users, Send reset link for others.
- "Forgotten your password?" on the sign-in screen emails a reset link. It
  gives the same answer whether or not the email has an account, and counts
  towards the 10-attempts-per-15-minutes limit.
- Setting a new password from a reset link signs out every other session on
  that account.
- Postmark only sends from a verified Sender Signature or domain; the Email
  tab explains the steps.

Clients, sites and users:

- A client is a hospitality group (for example Open House). A site is one
  venue under it (for example Broadcaster). Every site belongs to one client.
- Clients and sites screen: admins add clients, rename them, archive or reopen
  them, and delete a client once it has no sites. Archiving a client takes
  every one of its sites offline. Admins and client admins add sites to a
  client, rename them, move them between clients, and archive or reopen them.
  The site code keys that site's bookings in Redis and never changes. Each site
  has its own floor plan, SevenRooms connection, alert webhook, email webhook
  key and Postmark server, all on its Settings screen. A new site starts in
  shadow mode on the example floor plan. An archived site stops taking emails
  (Postmark is told to stop retrying), releases and reconciliation, and is
  hidden from managers and viewers; its bookings are kept. Sites are never deleted.
- Users screen: named users sign in by email. Access is given to whole clients
  (every site the client has now and adds later), to single sites, or, for
  admins only, to everything. Roles:
  - admin: every client and site, Settings, Users, Clients and sites;
  - client admin: their clients only; adds and edits those clients' sites,
    edits their settings, and manages users whose access lies wholly inside
    their clients. Cannot create admins, or add, archive or delete clients;
  - manager: their sites; runs releases and reconciliation, acknowledges alerts;
  - viewer: their sites, read only.
  Changing a user's role, access, email or password, or disabling them, signs
  that user out at once and nobody else. Nobody can disable, delete or change
  the role of their own account, and the last active admin cannot be removed.
  Users change their own password under My account.
- Admin log (Users screen): every client, site, user and settings change and
  who made it. A client admin sees only entries about their own clients.
- Existing installs: the single venue becomes the first site, under a client
  called "Unassigned". Rename that client (for example to Open House) on the
  Clients and sites screen.
- Shared passwords are retired. Everyone signs in with their own email and
  password. On an install from before named users, the team password stops
  working on deploy and its hash is deleted from storage. The old admin
  password works only until a named admin exists: sign in with it (Sign in,
  "Use the old admin password"), add yourself as an admin on the Users screen,
  and from that moment it is refused, its sessions end and its hash is deleted.
- If no active admin is ever left, the setup screen returns: the setup code
  from the Vercel logs creates a new admin and keeps every client, site and user.
- Scheduled jobs run every live site in turn; one site failing does not stop the others.

API: `GET /api/link?token=`, `POST /api/link/accept`, `POST /api/password-reset`,
`GET /api/admin/overview`, `GET|PUT /api/mail`, `POST /api/mail/test`,
`GET /api/mail/preview?kind=invite|reset`, `POST /api/users/:id/link`,
`GET /api/me`, `PUT /api/me/password`, `GET|POST /api/clients`,
`PUT|DELETE /api/clients/:id`, `GET|POST /api/sites`,
`GET|PUT /api/sites/:id`, `GET|POST /api/users`, `PUT|DELETE /api/users/:id`,
`GET /api/audit`. Dashboard and settings routes take `?site=`; without it the
user's first active site is used.

Access:

- Named users only: email and password, by role, client and site as above.
- Sessions last 12 hours. Changing a user's password, role or access, or
  disabling them, signs that user out.
- Ten failed sign-ins from one address lock it out for 15 minutes.
- Passwords are stored only as scrypt hashes.
- The email webhook accepts only requests carrying the key from Settings.
- Scheduled jobs (`vercel.json`, UTC): releases at 5 minutes past every hour,
  reconciliation at 06:30. They need no secret because both only act on what
  is already due and repeat safely; reconciliation runs at most once every 10
  minutes. Hourly jobs need a Vercel Pro team.

Every booking and release runs under a Redis lock, so two function instances
cannot place two bookings on the same table.

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
4. Floor plan: replace the example on the Settings screen with Broadcaster's
   real tables and an allocation sized from last quarter's OpenTable covers.
5. First-run setup, connecting Postmark, and the forwarding rule on the venue's inbox.

## Rules that do not change

- Hosts and the direct widget never sell a protected OpenTable table.
- An email the parser cannot read raises an alert. It is never dropped.
- A release keeps a reserve. Table Runner cannot close tables in OpenTable, so
  released tables stay bookable there until a host closes them. Each release
  holds back `release.holdBack` unsold tables per sitting; a late OpenTable
  booking goes on the reserve and never on a released table. When the reserve
  runs out with released tables still open in OpenTable, Table Runner raises a
  high alert to stop online sales for that sitting. See
  `docs/opentable-exposure.md` for sizing the reserve and the monitoring routine.
- The allocation stays in force after go-live. The sync removes re-keying; it
  does not replace the allocation.

## Tests

```bash
npm test
```
