import { createApp } from './app.js';
import { londonNow } from './clock.js';
import { floorPlanStatus } from './mode.js';
import { NotifyingAlerts, WebhookAlerts } from './alert.js';
import { SevenRoomsClient } from './adapters/sevenrooms.js';
import { PATTERNS_VERIFIED } from './adapters/opentable-email.js';
import {
  RedisRest, RedisStore, RedisLedger, RedisShadowSevenRooms, RedisAlerts, RedisActivity, RedisState, RedisLock,
} from './adapters/redis.js';
import { exampleConfig } from '../config/allocation.example.js';

export class ConfigError extends Error {}

// Builds the live service from Vercel environment variables.
//
//   KV_REST_API_URL / KV_REST_API_TOKEN   Upstash Redis (added by the Vercel
//     Marketplace integration; UPSTASH_REDIS_REST_* also accepted)
//   TABLE_RUNNER_CONFIG   venue allocation JSON; defaults to the example
//   SEVENROOMS_MODE       "shadow" (default) records intended reservations
//                         without contacting SevenRooms; "live" writes to it
//   ALERT_WEBHOOK_URL     optional Slack/Teams incoming webhook
export function createLiveApp(env, { fetchImpl = fetch, clock = () => londonNow() } = {}) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new ConfigError('Storage is not connected. Add Upstash Redis to this project from the Vercel Marketplace, then redeploy.');

  let config = exampleConfig;
  if (env.TABLE_RUNNER_CONFIG) {
    try {
      config = JSON.parse(env.TABLE_RUNNER_CONFIG);
    } catch {
      throw new ConfigError('TABLE_RUNNER_CONFIG is not valid JSON.');
    }
  }

  const sevenRoomsLive = env.SEVENROOMS_MODE === 'live';
  const redis = new RedisRest({ url, token, fetchImpl });
  const prefix = `tr:${config.venue}`;
  const notify = env.ALERT_WEBHOOK_URL ? [new WebhookAlerts(env.ALERT_WEBHOOK_URL)] : [];

  return createApp({
    config,
    clock,
    store: new RedisStore(redis, prefix),
    ledger: new RedisLedger(redis, prefix),
    sevenRooms: sevenRoomsLive
      ? new SevenRoomsClient({ clientId: env.SEVENROOMS_CLIENT_ID, clientSecret: env.SEVENROOMS_CLIENT_SECRET, venueId: env.SEVENROOMS_VENUE_ID })
      : new RedisShadowSevenRooms(redis, prefix),
    alerts: new NotifyingAlerts(new RedisAlerts(redis, prefix, { clock }), notify),
    activity: new RedisActivity(redis, prefix, { clock }),
    state: new RedisState(redis, prefix),
    lock: new RedisLock(redis, prefix),
    // Until SevenRooms is live, releases go to the host as a checklist.
    manualRelease: !sevenRoomsLive,
    mode: {
      demo: false,
      sevenRooms: sevenRoomsLive
        ? { live: true, value: 'Live', detail: 'Writing reservations to SevenRooms' }
        : { live: false, value: 'Shadow', detail: 'Recording where each booking would go; SevenRooms not touched' },
      openTable: { live: false, value: 'Email ledger', detail: 'Forwarded OpenTable emails; partner API not confirmed' },
      emailParser: PATTERNS_VERIFIED
        ? { live: true, value: 'Verified', detail: 'Patterns checked against real OpenTable emails' }
        : { live: false, value: 'Provisional', detail: 'Awaiting real OpenTable emails' },
      floorPlan: floorPlanStatus(config),
      alertsTo: notify.length ? 'Dashboard and webhook' : 'Dashboard only',
    },
  });
}
