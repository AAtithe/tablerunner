import { scrypt, randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { safeEqual } from './auth.js';
import { SevenRoomsClient } from './adapters/sevenrooms.js';
import { exampleConfig } from '../config/allocation.example.js';

// Everything that would otherwise be an environment variable lives here, in
// Redis, and is edited on the dashboard's Settings screen by an admin.
// Passwords are stored only as scrypt hashes.

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

export const isConfigured = (s) => Boolean(s.teamPasswordHash && s.adminPasswordHash);

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

export async function completeSetup(redis, { code, teamPassword, adminPassword }) {
  const store = new SettingsStore(redis);
  const current = await store.get();
  if (isConfigured(current)) throw userError(409, 'Table Runner is already set up.');
  const expected = await redis.cmd('GET', SETUP_KEY);
  if (!expected || !safeEqual(String(code ?? '').trim(), expected)) throw userError(403, 'That setup code is not correct. Copy it from the Vercel function logs.');
  checkPasswords({ teamPassword, adminPassword });

  const settings = {
    ...current,
    teamPasswordHash: await hashPassword(teamPassword),
    adminPasswordHash: await hashPassword(adminPassword),
    inboundSecret: randomSecret(),
    sessionEpoch: 1,
    alertWebhookUrl: '',
    sevenRooms: { mode: 'shadow', clientId: '', clientSecret: '', venueId: '' },
    floorPlan: current.floorPlan ?? exampleConfig,
  };
  await store.save(settings);
  await redis.cmd('DEL', SETUP_KEY);
  return settings;
}

// Applies an admin's changes. Returns the new settings and the names of the
// fields that changed (never their values), for the activity log.
export async function applySettingsChange(current, patch) {
  const next = structuredClone(current);
  const changed = [];
  const errors = [];

  if (patch.teamPassword || patch.adminPassword) {
    const team = patch.teamPassword || null;
    const admin = patch.adminPassword || null;
    for (const [name, pw] of [['Team password', team], ['Admin password', admin]]) {
      if (pw && pw.length < 10) errors.push(`${name} must be at least 10 characters.`);
    }
    if (team && admin && team === admin) errors.push('Team and admin passwords must be different.');
    if (team && !admin && await verifyPassword(team, current.adminPasswordHash)) errors.push('Team password must differ from the admin password.');
    if (admin && !team && await verifyPassword(admin, current.teamPasswordHash)) errors.push('Admin password must differ from the team password.');
    if (!errors.length) {
      if (team) { next.teamPasswordHash = await hashPassword(team); changed.push('team password'); }
      if (admin) { next.adminPasswordHash = await hashPassword(admin); changed.push('admin password'); }
      // Signs everyone out, so a leaked old password stops working at once.
      next.sessionEpoch = (current.sessionEpoch ?? 1) + 1;
    }
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
      sr.clientSecret = String(patch.sevenRooms.clientSecret).trim();
      changed.push('SevenRooms client secret');
    }
    if (patch.sevenRooms.mode && patch.sevenRooms.mode !== sr.mode) {
      if (!['shadow', 'live'].includes(patch.sevenRooms.mode)) errors.push('SevenRooms mode must be shadow or live.');
      else if (patch.sevenRooms.mode === 'live' && !SevenRoomsClient.implemented) {
        errors.push('SevenRooms cannot be switched to live yet: the live connection is still being built. Keep shadow mode.');
      } else if (patch.sevenRooms.mode === 'live' && !(sr.clientId && sr.clientSecret && sr.venueId)) {
        errors.push('Enter the SevenRooms client ID, client secret and venue ID before switching to live.');
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
export function publicSettings(s, origin) {
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
      liveAvailable: SevenRoomsClient.implemented,
    },
    floorPlan: s.floorPlan ?? exampleConfig,
  };
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
  return p;
}

export class Sessions {
  constructor(redis) {
    this.redis = redis;
  }

  #key(token) {
    return `tr:session:${createHash('sha256').update(token).digest('hex')}`;
  }

  async create(role, epoch) {
    const token = randomSecret(32);
    await this.redis.cmd('SET', this.#key(token), JSON.stringify({ role, epoch }), 'EX', SESSION_TTL_S);
    return token;
  }

  async verify(token, epoch) {
    if (!token) return null;
    const raw = await this.redis.cmd('GET', this.#key(token));
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s.epoch === epoch ? s.role : null;
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

function checkPasswords({ teamPassword, adminPassword }) {
  const errors = [];
  if (typeof teamPassword !== 'string' || teamPassword.length < 10) errors.push('Team password must be at least 10 characters.');
  if (typeof adminPassword !== 'string' || adminPassword.length < 10) errors.push('Admin password must be at least 10 characters.');
  if (!errors.length && teamPassword === adminPassword) errors.push('Team and admin passwords must be different.');
  if (errors.length) throw userError(400, errors.join(' '));
}

export function userError(status, message) {
  return Object.assign(new Error(message), { status });
}
