import { scrypt, randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { safeEqual } from './auth.js';
import { SevenRoomsClient } from './adapters/sevenrooms.js';
import { addKey, currentKeyInfo, decryptSecret, encryptSecret, isEncrypted, secretProblem } from './secrets.js';
import { exampleConfig } from '../config/allocation.example.js';

// Everything that would otherwise be an environment variable lives here, in
// Redis, and is edited on the dashboard's Settings screen by an admin.
// Passwords are stored only as scrypt hashes. Everyone signs in as a named
// user; the shared team and admin passwords of earlier versions are retired.
// The SevenRooms client secret must be read back, so it is encrypted instead,
// under a key the app keeps apart from the settings (see secrets.js).

const scryptAsync = promisify(scrypt);
const SETTINGS_KEY = 'tr:settings';
const SETUP_KEY = 'tr:setup-code';
const SESSION_TTL_S = 12 * 60 * 60;

export const randomSecret = (bytes = 24) => randomBytes(bytes).toString('base64url');

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const hash = (await scryptAsync(password, salt, 32)).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  return safeEqual((await scryptAsync(password, salt, 32)).toString('base64url'), hash);
}

export class SettingsStore {
  constructor(redis) {
    this.redis = redis;
  }

  async get() {
    const raw = await this.redis.cmd('GET', SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  }

  async save(settings) {
    await this.redis.cmd('SET', SETTINGS_KEY, JSON.stringify(settings));
  }
}

// Set up once there is an active named admin. An install from before named
// users also counts while its old admin password remains, so that admin can
// sign in once to create their own account.
export const isConfigured = (s) => Boolean(s.adminPasswordHash) || (s.users ?? []).some((u) => u.role === 'admin' && u.active);

// One-time code needed to claim a fresh install. It is written to the function
// logs, which only the Vercel team can read, so whoever finds the URL first
// cannot take the admin account.
export async function ensureSetupCode(redis, log) {
  let code = await redis.cmd('GET', SETUP_KEY);
  if (!code) {
    const fresh = randomSecret(9);
    await redis.cmd('SET', SETUP_KEY, fresh, 'NX');
    code = await redis.cmd('GET', SETUP_KEY);
  }
  log(`Table Runner setup code: ${code}`);
  return code;
}

// Checks the one-time setup code from the logs. The code is also the way
// back in if no active admin remains.
export async function checkSetupCode(redis, code) {
  const expected = await redis.cmd('GET', SETUP_KEY);
  if (!expected || !safeEqual(String(code ?? '').trim(), expected)) throw userError(403, 'That setup code is not correct. Copy it from the Vercel function logs.');
}

export const clearSetupCode = (redis) => redis.cmd('DEL', SETUP_KEY);

// First-run settings: one example site, no users yet (setup adds the admin).
export function initialSettings() {
  return {
    sessionEpoch: 1,
    inboundSecret: randomSecret(),
    alertWebhookUrl: '',
    sevenRooms: { mode: 'shadow', clientId: '', clientSecret: '', venueId: '' },
    floorPlan: exampleConfig,
  };
}

// Applies an admin's changes to one site. Returns the new settings and the
// names of the fields that changed (never their values), for the activity log.
// `keyring` encrypts a new client secret.
export async function applySettingsChange(current, patch, { keyring }) {
  const next = structuredClone(current);
  const changed = [];
  const errors = [];

  if (patch.teamPassword || patch.adminPassword) {
    errors.push('Shared passwords are retired. Give each person their own sign-in on the Users screen.');
  }

  if (patch.regenerateInboundSecret) {
    next.inboundSecret = randomSecret();
    changed.push('email webhook key');
  }

  if (patch.alertWebhookUrl !== undefined && patch.alertWebhookUrl !== current.alertWebhookUrl) {
    const v = String(patch.alertWebhookUrl).trim();
    if (v && !/^https:\/\/[^\s]+$/.test(v)) errors.push('Alert webhook must be an https:// address.');
    else { next.alertWebhookUrl = v; changed.push('alert webhook'); }
  }

  if (patch.sevenRooms) {
    const sr = { ...current.sevenRooms };
    for (const field of ['clientId', 'venueId']) {
      if (patch.sevenRooms[field] !== undefined && patch.sevenRooms[field] !== sr[field]) {
        sr[field] = String(patch.sevenRooms[field]).trim();
        changed.push(`SevenRooms ${field === 'clientId' ? 'client ID' : 'venue ID'}`);
      }
    }
    if (patch.sevenRooms.clientSecret) {
      sr.clientSecret = encryptSecret(String(patch.sevenRooms.clientSecret).trim(), keyring, CLIENT_SECRET_FIELD);
      changed.push('SevenRooms client secret');
    }
    if (patch.sevenRooms.mode && patch.sevenRooms.mode !== sr.mode) {
      if (!['shadow', 'live'].includes(patch.sevenRooms.mode)) errors.push('SevenRooms mode must be shadow or live.');
      else if (patch.sevenRooms.mode === 'live' && !SevenRoomsClient.implemented) {
        errors.push('SevenRooms cannot be switched to live yet: the live connection is still being built. Keep shadow mode.');
      } else if (patch.sevenRooms.mode === 'live' && !(sr.clientId && sr.clientSecret && sr.venueId)) {
        errors.push('Enter the SevenRooms client ID, client secret and venue ID before switching to live.');
      } else if (patch.sevenRooms.mode === 'live' && secretProblem(sr.clientSecret, keyring, CLIENT_SECRET_FIELD)) {
        errors.push(`SevenRooms cannot be switched to live: the client secret is saved but ${secretProblem(sr.clientSecret, keyring, CLIENT_SECRET_FIELD)}.`);
      } else {
        sr.mode = patch.sevenRooms.mode;
        changed.push('SevenRooms mode');
      }
    }
    next.sevenRooms = sr;
  }

  if (patch.floorPlan !== undefined) {
    const problems = validateFloorPlan(patch.floorPlan);
    if (patch.floorPlan?.venue && current.floorPlan?.venue && patch.floorPlan.venue !== current.floorPlan.venue) {
      problems.push(`"venue" cannot change from "${current.floorPlan.venue}": it identifies the stored bookings.`);
    }
    if (problems.length) errors.push(...problems.map((p) => `Floor plan: ${p}`));
    else { next.floorPlan = patch.floorPlan; changed.push('floor plan'); }
  }

  if (errors.length) throw userError(400, errors.join(' '));
  return { settings: next, changed };
}

export const inboundUrlFor = (s, origin) => (s.inboundSecret ? `${origin}/api/inbound-email?key=${s.inboundSecret}` : '');

// What the Settings screen may see: no hashes, no stored secrets.
export function publicSettings(s, origin, { keyring }) {
  return {
    inboundUrl: inboundUrlFor(s, origin),
    postmark: s.postmark
      ? {
        connected: true,
        serverName: s.postmark.serverName,
        inboundAddress: s.postmark.inboundAddress,
        connectedAt: s.postmark.connectedAt,
        // False if Postmark points at another address than the one in use now.
        pointsHere: s.postmark.hookUrl === inboundUrlFor(s, origin),
        hookHost: new URL(s.postmark.hookUrl).host,
      }
      : { connected: false },
    alertWebhookUrl: s.alertWebhookUrl ?? '',
    sevenRooms: {
      mode: s.sevenRooms?.mode ?? 'shadow',
      clientId: s.sevenRooms?.clientId ?? '',
      venueId: s.sevenRooms?.venueId ?? '',
      clientSecretSet: Boolean(s.sevenRooms?.clientSecret),
      clientSecretProblem: secretProblem(s.sevenRooms?.clientSecret, keyring, CLIENT_SECRET_FIELD),
      encryptionKeyCreated: currentKeyInfo(keyring).created,
      liveAvailable: SevenRoomsClient.implemented,
    },
    floorPlan: s.floorPlan ?? exampleConfig,
  };
}

export const CLIENT_SECRET_FIELD = 'sevenRooms.clientSecret';
export const POSTMARK_TOKEN_FIELD = 'postmark.serverToken';
export const MAIL_TOKEN_FIELD = 'mail.serverToken';

// Applies `fn(stored, field)` to every stored secret: each site's SevenRooms
// client secret and Postmark inbound token, and the install's Postmark
// sending token. Returns the new settings and how many values changed.
function mapSecrets(settings, fn) {
  let count = 0;
  const swap = (obj, prop, field) => {
    const stored = obj?.[prop];
    if (!stored) return obj;
    const next = fn(stored, field);
    if (next === stored) return obj;
    count++;
    return { ...obj, [prop]: next };
  };
  const sites = (settings.sites ?? []).map((site) => {
    const sevenRooms = swap(site.sevenRooms, 'clientSecret', CLIENT_SECRET_FIELD);
    const postmark = swap(site.postmark, 'serverToken', POSTMARK_TOKEN_FIELD);
    return sevenRooms === site.sevenRooms && postmark === site.postmark ? site : { ...site, sevenRooms, postmark };
  });
  const mail = swap(settings.mail, 'serverToken', MAIL_TOKEN_FIELD);
  return { settings: { ...settings, sites, ...(settings.mail ? { mail } : {}) }, count };
}

// A new encryption key for the whole install. Every secret that can be read
// is re-encrypted under it; one that cannot stays as it is and still has to
// be entered again. Returns the new settings and the keyring holding both
// keys, so the old one is dropped only once the settings are saved.
export function rotateEncryptionKey(settings, keyring, at) {
  const rotated = addKey(keyring, at);
  const r = mapSecrets(settings, (stored, field) => (secretProblem(stored, keyring, field)
    ? stored
    : encryptSecret(decryptSecret(stored, keyring, field), rotated, field)));
  return { settings: r.settings, keyring: rotated, count: r.count };
}

// Secrets saved in plain text before encryption existed are encrypted in
// place. Returns the new settings and how many were encrypted, or null if
// there were none.
export function encryptPlainSecrets(settings, keyring) {
  const r = mapSecrets(settings, (stored, field) => (isEncrypted(stored) ? stored : encryptSecret(stored, keyring, field)));
  return r.count ? r : null;
}

// Reads a stored secret for use. A secret that cannot be read means the
// connection has to be made again, so the message says where.
export function readSecret(stored, keyring, field, reconnect) {
  try {
    return decryptSecret(stored, keyring, field);
  } catch (err) {
    throw userError(400, `The saved ${field === MAIL_TOKEN_FIELD ? 'Postmark sending token' : field === POSTMARK_TOKEN_FIELD ? 'Postmark inbound token' : 'secret'} cannot be used: ${err.message.replace(/\. Enter it again on the Settings screen$/, '')}. ${reconnect}`);
  }
}

// Starting reserve for late OpenTable bookings until the coaching section has
// enough history to recommend figures: one table per sitting, two on Friday
// and Saturday late, when the venue has a sitting called "late".
export function startingHoldBack(plan) {
  const hb = { default: 1 };
  if ((plan?.sittings ?? []).some((s) => s?.name === 'late')) {
    hb.fri = { late: 2 };
    hb.sat = { late: 2 };
  }
  return hb;
}

// Saved floor plans from before the reserve existed have no holdBack. Adds the
// starting reserve once; a figure an admin has set is never touched.
export function withStartingHoldBack(settings) {
  const plan = settings?.floorPlan;
  if (!plan?.release || plan.release.holdBack !== undefined) return null;
  return { ...settings, floorPlan: { ...plan, release: { ...plan.release, holdBack: startingHoldBack(plan) } } };
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validateFloorPlan(c) {
  const p = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['must be a JSON object.'];
  if (typeof c.venue !== 'string' || !/^[a-z0-9-]+$/.test(c.venue)) p.push('"venue" must be lower-case letters, digits or hyphens.');
  if (c.venueName !== undefined && typeof c.venueName !== 'string') p.push('"venueName" must be text.');
  const tables = c.tables;
  if (!tables || typeof tables !== 'object' || !Object.keys(tables).length) p.push('"tables" must list at least one table.');
  else for (const [id, t] of Object.entries(tables)) {
    if (!Number.isInteger(t?.seats) || t.seats < 1) p.push(`table ${id} needs a whole number of seats.`);
  }
  if (!Array.isArray(c.sittings) || !c.sittings.length) p.push('"sittings" must list at least one sitting.');
  else for (const s of c.sittings) {
    if (!s?.name || !HM.test(s.start ?? '') || !HM.test(s.end ?? '') || s.start >= s.end) p.push(`sitting "${s?.name ?? '?'}" needs a name and a start before its end, as HH:MM.`);
  }
  const names = new Set((c.sittings ?? []).map((s) => s?.name));
  if (!c.openTable?.default) p.push('"openTable" needs a "default" allocation.');
  for (const [day, plan] of Object.entries(c.openTable ?? {})) {
    if (!['default', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day)) { p.push(`"openTable.${day}" is not a weekday (mon to sun, or default).`); continue; }
    for (const [sitting, ids] of Object.entries(plan ?? {})) {
      if (!names.has(sitting)) p.push(`"openTable.${day}.${sitting}" is not a sitting.`);
      if (!Array.isArray(ids)) { p.push(`"openTable.${day}.${sitting}" must be a list of tables.`); continue; }
      for (const id of ids) if (!tables?.[id]) p.push(`"openTable.${day}.${sitting}" uses unknown table ${id}.`);
      if (new Set(ids).size !== ids.length) p.push(`"openTable.${day}.${sitting}" lists a table twice.`);
    }
  }
  if (!Number.isInteger(c.release?.daysBefore) || c.release.daysBefore < 0) p.push('"release.daysBefore" must be a whole number of days.');
  if (!HM.test(c.release?.time ?? '')) p.push('"release.time" must be HH:MM.');
  const hb = c.release?.holdBack;
  const count = (v) => Number.isInteger(v) && v >= 0;
  if (hb !== undefined && !count(hb)) {
    if (!hb || typeof hb !== 'object' || Array.isArray(hb)) p.push('"release.holdBack" must be a whole number, or an object of sittings and weekdays.');
    else for (const [k, v] of Object.entries(hb)) {
      const isDay = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(k);
      if (k !== 'default' && !names.has(k) && !isDay) p.push(`"release.holdBack.${k}" is not a sitting, weekday or default.`);
      else if (isDay && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) {
          if (!names.has(sk)) p.push(`"release.holdBack.${k}.${sk}" is not a sitting.`);
          else if (!count(sv)) p.push(`"release.holdBack.${k}.${sk}" must be a whole number of tables.`);
        }
      } else if (!count(v)) p.push(`"release.holdBack.${k}" must be a whole number of tables.`);
    }
  }
  return p;
}

export class Sessions {
  constructor(redis) {
    this.redis = redis;
  }

  #key(token) {
    return `tr:session:${createHash('sha256').update(token).digest('hex')}`;
  }

  // `extra` carries a named user's id and their own epoch, so changing one
  // user's access signs out only that user.
  async create(role, epoch, extra = {}) {
    const token = randomSecret(32);
    await this.redis.cmd('SET', this.#key(token), JSON.stringify({ role, epoch, ...extra }), 'EX', SESSION_TTL_S);
    return token;
  }

  // The stored session if it is still valid for this install epoch.
  async verify(token, epoch) {
    if (!token) return null;
    const raw = await this.redis.cmd('GET', this.#key(token));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s.epoch === epoch ? s : null;
  }

  async destroy(token) {
    if (token) await this.redis.cmd('DEL', this.#key(token));
  }
}

// At most `limit` failed sign-ins per address per 15 minutes.
export async function loginAllowed(redis, address, limit = 10) {
  const n = Number(await redis.cmd('GET', `tr:login-fail:${address}`)) || 0;
  return n < limit;
}

export async function recordLoginFailure(redis, address) {
  const key = `tr:login-fail:${address}`;
  await redis.cmd('INCR', key);
  await redis.cmd('EXPIRE', key, 900);
}

export function userError(status, message) {
  return Object.assign(new Error(message), { status });
}
