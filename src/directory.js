import { randomUUID } from 'node:crypto';
import { hashPassword, randomSecret, userError } from './settings.js';
import { exampleConfig } from '../config/allocation.example.js';

// Users and sites.
//
// A site is one venue: its own floor plan, SevenRooms connection, alert
// channel, email webhook key and Postmark server. Its id is the floor plan's
// "venue" code, which also prefixes every Redis key holding its bookings, so
// it never changes once created. Sites are archived, never deleted, so no
// booking history is lost.
//
// A user is a named sign-in (email and password) with a role and the sites
// they may see. The shared team and admin passwords from first-run setup keep
// working alongside named users.

export const ROLES = {
  admin: 'Admin: every site, settings, users and sites',
  manager: 'Manager: their sites, can run releases, reconciliation and acknowledge alerts',
  viewer: 'Viewer: their sites, read only',
};

// Fields that belong to a site rather than to the whole install.
export const SITE_FIELDS = ['floorPlan', 'sevenRooms', 'alertWebhookUrl', 'inboundSecret', 'postmark'];

const SITE_ID = /^[a-z0-9-]{2,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Settings saved before sites existed held one venue's fields at the top
// level. Move them into the first site. Safe to run on every read.
export function normaliseSettings(s) {
  if (!s || typeof s !== 'object') return s;
  const out = { ...s };
  if (!Array.isArray(out.sites)) {
    const floorPlan = out.floorPlan ?? exampleConfig;
    const site = { id: floorPlan.venue, name: floorPlan.venueName ?? floorPlan.venue, active: true };
    for (const f of SITE_FIELDS) if (out[f] !== undefined) site[f] = out[f];
    site.floorPlan = floorPlan;
    out.sites = out.teamPasswordHash || out.floorPlan ? [site] : [];
  }
  for (const f of SITE_FIELDS) delete out[f];
  if (!Array.isArray(out.users)) out.users = [];
  return out;
}

export function newSite({ id, name, at }) {
  return {
    id,
    name,
    active: true,
    createdAt: at,
    floorPlan: { ...structuredClone(exampleConfig), venue: id, venueName: name },
    sevenRooms: { mode: 'shadow', clientId: '', clientSecret: '', venueId: '' },
    alertWebhookUrl: '',
    inboundSecret: randomSecret(),
  };
}

export const findSite = (s, id) => s.sites.find((x) => x.id === id) ?? null;
export const findUser = (s, id) => s.users.find((x) => x.id === id) ?? null;
export const findUserByEmail = (s, email) => s.users.find((u) => u.email === normaliseEmail(email)) ?? null;
const normaliseEmail = (e) => String(e ?? '').trim().toLowerCase();

// The flat shape the settings, Postmark and live-app code work on: install
// fields plus one site's fields. `putSiteView` writes it back.
export function siteView(settings, siteId) {
  const site = findSite(settings, siteId);
  if (!site) return null;
  const view = { ...settings };
  delete view.sites; delete view.users;
  for (const f of SITE_FIELDS) if (site[f] !== undefined) view[f] = site[f];
  return view;
}

export function putSiteView(settings, siteId, view) {
  const next = { ...settings };
  next.sites = settings.sites.map((site) => {
    if (site.id !== siteId) return site;
    const out = { ...site };
    for (const f of SITE_FIELDS) {
      if (view[f] === undefined) delete out[f];
      else out[f] = view[f];
    }
    if (out.floorPlan?.venueName) out.name = out.floorPlan.venueName;
    return out;
  });
  for (const f of [...Object.keys(view)]) {
    if (!SITE_FIELDS.includes(f)) next[f] = view[f];
  }
  return next;
}

// ---- Who is signed in

// Shared passwords: admin sees everything; team works every site with a
// manager's rights.
export function sharedPrincipal(role) {
  const admin = role === 'admin';
  return { kind: 'shared', role: admin ? 'admin' : 'team', name: admin ? 'Admin password' : 'Team password', sites: ['*'] };
}

export function userPrincipal(user) {
  return { kind: 'user', userId: user.id, role: user.role, name: user.name, email: user.email, sites: user.role === 'admin' ? ['*'] : user.sites };
}

export const canSeeSite = (p, site) => p.role === 'admin' || (site.active && (p.sites.includes('*') || p.sites.includes(site.id)));
export const visibleSites = (p, settings) => settings.sites.filter((s) => canSeeSite(p, s));
export const canAct = (p) => ['admin', 'manager', 'team'].includes(p.role);

// ---- Users

export function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, sites: u.sites, active: u.active,
    createdAt: u.createdAt, updatedAt: u.updatedAt ?? null, lastSignInAt: u.lastSignInAt ?? null,
  };
}

function checkUserFields(settings, { name, email, role, sites }, { creating, selfId } = {}) {
  const errors = [];
  if (creating || name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) errors.push('Enter a name.');
  }
  if (creating || email !== undefined) {
    const e = normaliseEmail(email);
    if (!EMAIL.test(e)) errors.push('Enter a valid email address.');
    else {
      const other = findUserByEmail(settings, e);
      if (other && other.id !== selfId) errors.push(`${e} already has an account.`);
    }
  }
  if (creating || role !== undefined) {
    if (!Object.hasOwn(ROLES, role)) errors.push('Role must be admin, manager or viewer.');
  }
  if (creating || sites !== undefined) {
    if (!Array.isArray(sites)) errors.push('Sites must be a list.');
    else {
      for (const id of sites) if (id !== '*' && !findSite(settings, id)) errors.push(`Unknown site ${id}.`);
      if (role !== 'admin' && creating && !sites.length) errors.push('Give the user at least one site, or all sites.');
    }
  }
  return errors;
}

function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return ['Password must be at least 10 characters.'];
  return [];
}

export async function createUser(settings, body, { at }) {
  const errors = [...checkUserFields(settings, body, { creating: true }), ...checkNewPassword(body.password)];
  if (errors.length) throw userError(400, errors.join(' '));
  const user = {
    id: randomUUID(),
    name: body.name.trim(),
    email: normaliseEmail(body.email),
    role: body.role,
    sites: body.role === 'admin' ? ['*'] : [...new Set(body.sites)],
    active: true,
    epoch: 1,
    passwordHash: await hashPassword(body.password),
    createdAt: at,
  };
  return { settings: { ...settings, users: [...settings.users, user] }, user, message: `User ${user.email} added as ${user.role}` };
}

// `actor` is the signed-in principal, so an admin cannot lock themselves out.
export async function updateUser(settings, id, body, { at, actor }) {
  const user = findUser(settings, id);
  if (!user) throw userError(404, 'User not found.');
  const self = actor.kind === 'user' && actor.userId === id;
  const errors = checkUserFields(settings, { ...body, role: body.role ?? (body.sites !== undefined ? user.role : undefined) }, { selfId: id });
  if (body.password !== undefined) errors.push(...checkNewPassword(body.password));
  if (self && body.active === false) errors.push('You cannot disable your own account.');
  if (self && body.role !== undefined && body.role !== 'admin' && user.role === 'admin') errors.push('You cannot remove your own admin role.');
  if (errors.length) throw userError(400, errors.join(' '));

  const next = { ...user };
  const changed = [];
  if (body.name !== undefined && body.name.trim() !== user.name) { next.name = body.name.trim(); changed.push('name'); }
  if (body.email !== undefined && normaliseEmail(body.email) !== user.email) { next.email = normaliseEmail(body.email); changed.push('email'); }
  if (body.role !== undefined && body.role !== user.role) { next.role = body.role; changed.push('role'); }
  if (next.role === 'admin') next.sites = ['*'];
  else if (body.sites !== undefined) {
    const sites = [...new Set(body.sites)];
    if (!sites.length) throw userError(400, 'Give the user at least one site, or all sites.');
    if (JSON.stringify(sites) !== JSON.stringify(user.sites)) { next.sites = sites; changed.push('sites'); }
  } else if (user.role === 'admin' && next.role !== 'admin') {
    throw userError(400, 'Choose which sites this user may see.');
  }
  if (body.active !== undefined && Boolean(body.active) !== user.active) { next.active = Boolean(body.active); changed.push(next.active ? 'enabled' : 'disabled'); }
  if (body.password !== undefined) { next.passwordHash = await hashPassword(body.password); changed.push('password'); }
  // Any change to access, or a new password, ends that user's open sessions.
  if (changed.some((c) => ['role', 'sites', 'disabled', 'password', 'email'].includes(c))) next.epoch = (user.epoch ?? 1) + 1;
  if (changed.length) next.updatedAt = at;

  return {
    settings: { ...settings, users: settings.users.map((u) => (u.id === id ? next : u)) },
    user: next,
    changed,
    message: changed.length ? `User ${next.email} changed: ${changed.join(', ')}` : '',
  };
}

export function deleteUser(settings, id, { actor }) {
  const user = findUser(settings, id);
  if (!user) throw userError(404, 'User not found.');
  if (actor.kind === 'user' && actor.userId === id) throw userError(400, 'You cannot delete your own account.');
  return { settings: { ...settings, users: settings.users.filter((u) => u.id !== id) }, message: `User ${user.email} deleted` };
}

// ---- Sites

export function publicSite(site, { full = false } = {}) {
  const fp = site.floorPlan ?? {};
  const out = {
    id: site.id,
    name: site.name,
    active: site.active,
    example: Boolean(fp.example),
    tables: Object.keys(fp.tables ?? {}).length,
    sittings: (fp.sittings ?? []).length,
  };
  if (full) {
    Object.assign(out, {
      createdAt: site.createdAt ?? null,
      sevenRoomsMode: site.sevenRooms?.mode ?? 'shadow',
      postmarkConnected: Boolean(site.postmark),
      alertWebhook: Boolean(site.alertWebhookUrl),
    });
  }
  return out;
}

export function createSite(settings, body, { at }) {
  const id = String(body.id ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const errors = [];
  if (!SITE_ID.test(id)) errors.push('Site code must be 2 to 40 lower-case letters, digits or hyphens.');
  else if (findSite(settings, id)) errors.push(`A site with code ${id} already exists.`);
  if (!name) errors.push('Enter the site name.');
  if (errors.length) throw userError(400, errors.join(' '));
  const site = newSite({ id, name, at });
  return { settings: { ...settings, sites: [...settings.sites, site] }, site, message: `Site ${name} (${id}) added` };
}

export function updateSite(settings, id, body, { at }) {
  const site = findSite(settings, id);
  if (!site) throw userError(404, 'Site not found.');
  const next = { ...site };
  const changed = [];
  if (body.id !== undefined && body.id !== id) throw userError(400, 'A site code cannot change: it identifies the stored bookings.');
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw userError(400, 'Enter the site name.');
    if (name !== site.name) {
      next.name = name;
      next.floorPlan = { ...site.floorPlan, venueName: name };
      changed.push('name');
    }
  }
  if (body.active !== undefined && Boolean(body.active) !== site.active) {
    if (!body.active && settings.sites.filter((s) => s.active).length === 1) throw userError(400, 'At least one site must stay active.');
    next.active = Boolean(body.active);
    changed.push(next.active ? 'reopened' : 'archived');
  }
  if (changed.length) next.updatedAt = at;
  return {
    settings: { ...settings, sites: settings.sites.map((s) => (s.id === id ? next : s)) },
    site: next,
    changed,
    message: changed.length ? `Site ${next.name} (${id}) changed: ${changed.join(', ')}` : '',
  };
}
