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

// The only connection read from the environment: the database that holds
// every other setting. Vercel adds it when Upstash Redis is connected to the
// project from the Marketplace; nobody types it in.
export function redisFromEnv(env, { fetchImpl = fetch } = {}) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new ConfigError('Storage is not connected. In Vercel, open the tablerunner project, choose Storage, connect Upstash Redis, then redeploy.');
  }
  return new RedisRest({ url, token, fetchImpl });
}

// Builds the live service from the settings saved in the app.
export function createLiveApp({ redis, settings, clock = () => londonNow() }) {
  const config = settings.floorPlan ?? exampleConfig;
  const sr = settings.sevenRooms ?? { mode: 'shadow' };
  const sevenRoomsLive = sr.mode === 'live' && SevenRoomsClient.implemented;
  const prefix = `tr:${config.venue}`;
  const notify = settings.alertWebhookUrl ? [new WebhookAlerts(settings.alertWebhookUrl)] : [];

  return createApp({
    config,
    clock,
    store: new RedisStore(redis, prefix),
    ledger: new RedisLedger(redis, prefix),
    sevenRooms: sevenRoomsLive
      ? new SevenRoomsClient({ clientId: sr.clientId, clientSecret: sr.clientSecret, venueId: sr.venueId })
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
