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
| `src/release.js` | Releases unsold allocation, by API or as a host checklist (`manual: true`) |
| `src/reconcile.js` | Daily OpenTable vs SevenRooms comparison with alert |
| `src/adapters/opentable-email.js` | Parses OpenTable notification emails (fallback if no partner API) |
| `src/adapters/sevenrooms.js` | SevenRooms adapter contract, in-memory double, live client stub |
| `test/sevenrooms-contract.js` | Contract tests every SevenRooms adapter must pass, including the live client against the sandbox |
| `docs/runbook-sevenrooms-failure.md` | What hosts and the sync owner do when the sync fails during service |
| `src/alert.js` | Alert sinks |
| `src/store.js` | Booking ledger keyed by OpenTable confirmation number |
| `src/adapters/opentable-ledger.js` | OpenTable's own record of bookings, kept apart so reconciliation compares two independent sources |
| `src/app.js` | Wires sync, releases, reconciliation, alerts and the activity log |
| `src/server.js`, `public/index.html` | Dashboard and JSON API |
| `scripts/demo.js` | Dashboard on synthetic data with in-memory vendors |
| `src/adapters/redis.js` | Redis storage, shadow SevenRooms and the cross-instance booking lock; Upstash REST client |
| `src/adapters/redis-tcp.js` | Direct Redis connection from `REDIS_URL` |
| `src/settings.js` | In-app settings, first-run setup, password hashing, sessions, floor plan validation |
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
- Buttons to run reconciliation and releases on demand.

The local demo binds to localhost. `DASHBOARD_PASSWORD` adds a password if
you expose it on a network; the live service on Vercel does not use it.

API: `GET /api/status`, `GET /api/day?date=`, `GET /api/week?from=`,
`GET /api/alerts`, `GET /api/activity`, `POST /api/reconcile`,
`POST /api/release`, `POST /api/inbound-email`, `POST /api/alerts/:id/ack`.

## Live deployment (Vercel)

The live service runs as one Vercel function behind `/api`, with Redis for
storage: Upstash over its REST API when connected, otherwise any Redis
database through its `REDIS_URL`. The dashboard is at `/` and the browser-only demo at `/demo`.

All settings live in the app, on the admin Settings screen: passwords, the
email webhook key, the alert channel, SevenRooms details and the floor plan.
There are no environment variables to set. The only connection outside the app
is the one to the database that holds those settings, and Vercel creates it
when a Redis database is connected.

Setup, once:

1. In Vercel, open the tablerunner project, choose Storage, and connect a
   Redis database (Upstash for Redis, or Redis). Redeploy.
2. Open the site. It asks for a setup code. The code is in the project's
   Vercel logs (search for "setup code"), which only the Vercel team can see.
   Enter it with a team password and a different admin password.
3. Settings opens. Copy the webhook address into a Postmark inbound stream,
   and forward OpenTable notification emails to that stream's address.
4. Optionally add a Slack or Teams incoming webhook for alerts.
5. Paste the venue's real floor plan and allocation, and set `"example"` to
   `false`.

Until SevenRooms is switched to live, the service runs in shadow mode: every
OpenTable email is processed and shown with the table it would take, but
nothing is written to SevenRooms. The Settings screen refuses live mode until
the SevenRooms connection is built (`SevenRoomsClient.implemented`).

Access:

- Team password: dashboard. Admin password: dashboard and Settings.
- Sessions last 12 hours. Changing a password signs everyone else out.
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
   documentation from the account manager. Requested 31 October 2026, see
   `docs/sevenrooms-api-request.md`.
2. OpenTable email patterns: the current patterns are provisional. Replace them
   from 10 to 20 real confirmation, modification and cancellation emails.
3. OpenTable booking list for reconciliation: depends on partner API access, or
   on building the list from the synced emails if access is refused.
4. Floor plan: replace the example on the Settings screen with Broadcaster's
   real tables and an allocation sized from last quarter's OpenTable covers.
5. First-run setup and a Postmark inbound stream.

## Rules that do not change

- Hosts and the direct widget never sell a protected OpenTable table.
- An email the parser cannot read raises an alert. It is never dropped.
- A release is two-sided. A released table is closed in OpenTable as well as
  opened in SevenRooms, and the sync never places a later OpenTable booking
  on it.
- The allocation stays in force after go-live. The sync removes re-keying; it
  does not replace the allocation.

## Tests

```bash
npm test
```

The SevenRooms contract tests run against the in-memory double and the shadow
store on every run. Once the live client is written, run them against the
SevenRooms sandbox before setting `SevenRoomsClient.implemented` to true:

```bash
SEVENROOMS_SANDBOX_CLIENT_ID=... SEVENROOMS_SANDBOX_CLIENT_SECRET=... \
SEVENROOMS_SANDBOX_VENUE_ID=... SEVENROOMS_SANDBOX_BASE_URL=... \
SEVENROOMS_SANDBOX_TABLES=A1,A2 SEVENROOMS_SANDBOX_DATE=2027-01-12 \
npm test
```

These settings are read only by the test run. The service takes its
SevenRooms settings from the Settings screen.
