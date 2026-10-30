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
| `src/alert.js` | Alert sinks |
| `src/store.js` | Booking ledger keyed by OpenTable confirmation number |
| `src/adapters/opentable-ledger.js` | OpenTable's own record of bookings, kept apart so reconciliation compares two independent sources |
| `src/app.js` | Wires sync, releases, reconciliation, alerts and the activity log |
| `src/server.js`, `public/index.html` | Dashboard and JSON API |
| `scripts/demo.js` | Dashboard on synthetic data with in-memory vendors |
| `src/adapters/redis.js` | Upstash Redis storage, shadow SevenRooms and the cross-instance booking lock |
| `src/live.js`, `src/vercel.js`, `api/index.js` | Live service on Vercel: wiring from environment variables, authenticated API |
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

The dashboard shows guest names and contact details. Set `DASHBOARD_PASSWORD`
(HTTP Basic auth) before it is reachable from anywhere but the machine running it.

API: `GET /api/status`, `GET /api/day?date=`, `GET /api/week?from=`,
`GET /api/alerts`, `GET /api/activity`, `POST /api/reconcile`,
`POST /api/release`, `POST /api/inbound-email`, `POST /api/alerts/:id/ack`.

## Live deployment (Vercel)

The live service runs as one Vercel function behind `/api`, with Upstash
Redis for storage. The dashboard is at `/` and the browser-only demo at `/demo`.

Until `SEVENROOMS_MODE=live`, it runs in shadow mode: every OpenTable email is
processed and shown with the table it would take, but nothing is written to
SevenRooms. That is the parallel run before go-live.

Setup, once, in the Vercel project:

1. Storage: Marketplace, Upstash Redis, connect to this project. This sets
   `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. Environment variables (Production and Preview):
   - `DASHBOARD_PASSWORD`: the team password for the dashboard.
   - `INBOUND_SECRET`: long random string for the email webhook.
   - `CRON_SECRET`: long random string; Vercel sends it with scheduled jobs.
   - `ALERT_WEBHOOK_URL` (optional): Slack or Teams incoming webhook.
   - `TABLE_RUNNER_CONFIG` (when ready): the venue's real allocation JSON, in
     the shape of `config/allocation.example.js`.
   - `SEVENROOMS_MODE=live` plus `SEVENROOMS_CLIENT_ID`,
     `SEVENROOMS_CLIENT_SECRET`, `SEVENROOMS_VENUE_ID`: only once the live
     client is implemented and the parallel run is clean.
3. Redeploy.
4. Email: create a Postmark inbound stream and set its webhook to
   `https://<production domain>/api/inbound-email?key=<INBOUND_SECRET>`.
   Forward OpenTable notification emails to its inbound address.
5. Check `https://<production domain>/api/health` returns `{"ok":true}`.

Scheduled jobs (`vercel.json`, UTC): releases at 5 minutes past every hour,
reconciliation at 06:30. Hourly jobs need a Vercel Pro team.

Every route fails closed: a route whose secret is not set returns 503.
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
4. Allocation config: replace the example with Broadcaster's real floor plan and an
   allocation sized from last quarter's OpenTable covers. `venue` and
   `venueName` set which venue the instance serves.
5. Postmark inbound stream and the Vercel environment variables above.

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
