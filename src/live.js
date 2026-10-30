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
  // Vercel may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so match on
  // the suffix as well as the standard names.
  const find = (...suffixes) => {
    for (const s of suffixes) if (env[s]) return env[s];
    const key = Object.keys(env).find((k) => suffixes.some((s) => k.endsWith(`_${s}`)) && env[k]);
    return key ? env[key] : undefined;
  };
  const url = find('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
  const token = find('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) {
    // Names only, never values, so the cause can be read off the error.
    const seen = Object.keys(env).filter((k) => /REDIS|KV_|UPSTASH/.test(k)).sort();
    const detail = seen.length
      ? ` Storage settings found: ${seen.join(', ')}. ${seen.includes('REDIS_URL') && seen.length === 1
        ? 'That is a plain Redis connection; Table Runner needs Upstash for Redis, which also provides KV_REST_API_URL and KV_REST_API_TOKEN.'
        : 'KV_REST_API_URL and KV_REST_API_TOKEN must both be present for Production.'}`
      : ' No storage settings were found in this deployment.';
    throw new ConfigError(`Storage is not connected. In Vercel, open the tablerunner project, choose Storage, connect Upstash for Redis to Production, then redeploy.${detail}`);
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
