import { randomUUID } from 'node:crypto';
import { hashPassword, randomSecret, userError } from './settings.js';
import { exampleConfig } from '../config/allocation.example.js';

// Clients, sites and users.
//
// A client is a hospitality group (for example Open House). It owns one or
// more sites. Clients are renamed, archived or, when empty, deleted.
//
// A site is one venue (for example Broadcaster): its own floor plan,
// SevenRooms connection, alert channel, email webhook key and Postmark
// server. Its id is the floor plan's "venue" code, which also prefixes every
// Redis key holding its bookings, so it never changes once created. A site can
// move to another client. Sites are archived, never deleted, so no booking
// history is lost. A site is live only while it and its client are active.
//
// A user is a named sign-in (email and password) with a role, and access to
// whole clients (every site of that client, including future ones) and/or
// individual sites. Everyone signs in as a named user. The shared team and
// admin passwords of earlier versions are retired: the team password at once,
// the admin password as soon as a named admin exists.

export const ROLES = {
  admin: 'Admin: every client and site, settings, users, clients and sites',
  client_admin: "Client admin: their clients' sites, settings and users; can add sites to their clients",
  manager: 'Manager: their sites, can run releases, reconciliation and acknowledge alerts',
  viewer: 'Viewer: their sites, read only',
};

// Fields that belong to a site rather than to the whole install.
export const SITE_FIELDS = ['floorPlan', 'sevenRooms', 'alertWebhookUrl', 'inboundSecret', 'postmark'];

const SITE_ID = /^[a-z0-9-]{2,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Sites saved before clients existed are placed here; rename it to the
// group's real name on the Clients and sites screen.
export const FIRST_CLIENT = { id: 'client-1', name: 'Unassigned' };

const slug = (v) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// Settings saved before sites existed held one venue's fields at the top
// level; settings saved before clients existed had sites with no client.
// Both are brought up to date here. Deterministic, so safe on every read.
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
  out.clients = Array.isArray(out.clients) ? out.clients : [];
  if (out.sites.some((x) => !x.clientId)) {
    if (!out.clients.some((c) => c.id === FIRST_CLIENT.id)) out.clients = [...out.clients, { ...FIRST_CLIENT, active: true }];
    out.sites = out.sites.map((x) => (x.clientId ? x : { ...x, clientId: FIRST_CLIENT.id }));
  }
  out.users = (Array.isArray(out.users) ? out.users : []).map((u) => (Array.isArray(u.clients) ? u : { ...u, clients: [] }));
  // Retired shared passwords. The old admin password survives only until a
  // named admin exists, so an existing install can create one.
  delete out.teamPasswordHash;
  if (activeAdmins(out).length) delete out.adminPasswordHash;
  return out;
}

export function newSite({ id, name, clientId, at }) {
  return {
    id,
    name,
    clientId,
    active: true,
    createdAt: at,
    floorPlan: { ...structuredClone(exampleConfig), venue: id, venueName: name },
    sevenRooms: { mode: 'shadow', clientId: '', clientSecret: '', venueId: '' },
    alertWebhookUrl: '',
    inboundSecret: randomSecret(),
  };
}

export const activeAdmins = (s) => (s.users ?? []).filter((u) => u.role === 'admin' && u.active);
export const findSite = (s, id) => s.sites.find((x) => x.id === id) ?? null;
export const findClient = (s, id) => s.clients.find((x) => x.id === id) ?? null;
export const findUser = (s, id) => s.users.find((x) => x.id === id) ?? null;
export const findUserByEmail = (s, email) => s.users.find((u) => u.email === normaliseEmail(email)) ?? null;
const normaliseEmail = (e) => String(e ?? '').trim().toLowerCase();

// The flat shape the settings, Postmark and live-app code work on: install
// fields plus one site's fields. `putSiteView` writes it back.
export function siteView(settings, siteId) {
  const site = findSite(settings, siteId);
  if (!site) return null;
  const view = { ...settings };
  delete view.sites; delete view.users; delete view.clients;
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

// The retiring admin password of an install from before named users. It
// has admin rights only until the first named admin is created.
export function legacyAdminPrincipal() {
  return { kind: 'legacy', role: 'admin', name: 'Old admin password', sites: ['*'], clients: [] };
}

export function userPrincipal(user) {
  return {
    kind: 'user', userId: user.id, role: user.role, name: user.name, email: user.email,
    sites: user.role === 'admin' ? ['*'] : user.sites, clients: user.clients ?? [],
  };
}

// A site serves bookings only while it and its client are both active.
export const siteLive = (settings, site) => Boolean(site.active && (findClient(settings, site.clientId)?.active ?? true));

const reaches = (p, site) => p.role === 'admin' || p.sites.includes('*') || p.sites.includes(site.id) || p.clients.includes(site.clientId);

// Admins and client admins also see archived sites they manage, so they can
// reopen them. Everyone else sees live sites only.
export function canSeeSite(p, site, settings) {
  if (!reaches(p, site)) return false;
  return canManageSite(p, site) || siteLive(settings, site);
}
export const visibleSites = (p, settings) => settings.sites.filter((x) => canSeeSite(p, x, settings));
export const canAct = (p) => ['admin', 'client_admin', 'manager'].includes(p.role);

// Who may manage what. Admins manage everything; client admins manage their
// own clients, those clients' sites, and users whose access lies wholly
// inside those clients.
export const canManage = (p) => p.role === 'admin' || p.role === 'client_admin';
export const canManageClient = (p, clientId) => p.role === 'admin' || (p.role === 'client_admin' && p.clients.includes(clientId));
export const canManageSite = (p, site) => canManageClient(p, site.clientId);
export const managedClients = (p, settings) => settings.clients.filter((c) => canManageClient(p, c.id));

export function canManageUser(p, user, settings) {
  if (p.role === 'admin') return true;
  if (p.role !== 'client_admin') return false;
  if (user.role === 'admin' || user.sites.includes('*')) return false;
  if (!user.clients.every((c) => p.clients.includes(c))) return false;
  return user.sites.every((id) => {
    const site = findSite(settings, id);
    return site && p.clients.includes(site.clientId);
  });
}

// Client ids an audit entry concerns, so client admins see their own entries.
export const clientsOfUser = (settings, u) => [...new Set([...u.clients, ...u.sites.map((id) => findSite(settings, id)?.clientId).filter(Boolean)])];

// ---- Users

export function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email, role: u.role, sites: u.sites, clients: u.clients ?? [], active: u.active,
    createdAt: u.createdAt, updatedAt: u.updatedAt ?? null, lastSignInAt: u.lastSignInAt ?? null,
  };
}

function checkUserFields(settings, { name, email }, { creating, selfId } = {}) {
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
  return errors;
}

// Role and access as they will be saved, checked as a whole.
function resolveAccess(settings, { role, sites, clients }, actor) {
  const errors = [];
  if (!Object.hasOwn(ROLES, role)) return { errors: ['Role must be admin, client admin, manager or viewer.'] };
  if (!Array.isArray(sites ?? []) || !Array.isArray(clients ?? [])) return { errors: ['Sites and clients must be lists.'] };
  let s = [...new Set(sites ?? [])];
  let c = [...new Set(clients ?? [])];
  for (const id of s) if (id !== '*' && !findSite(settings, id)) errors.push(`Unknown site ${id}.`);
  for (const id of c) if (!findClient(settings, id)) errors.push(`Unknown client ${id}.`);
  if (role === 'admin') { s = ['*']; c = []; }
  else if (role === 'client_admin') {
    if (s.length) errors.push('A client admin is given whole clients, not single sites.');
    if (!c.length) errors.push('Choose at least one client for this client admin.');
  } else if (!s.length && !c.length) errors.push('Give the user at least one client or site.');
  if (!errors.length && actor.role !== 'admin') {
    if (role === 'admin') errors.push('Only an admin can create admins.');
    else if (s.includes('*')) errors.push('Only an admin can give access to every site.');
    else if (!canManageUser(actor, { role, sites: s, clients: c }, settings)) errors.push('You can only give access to your own clients and their sites.');
  }
  return { errors, sites: s, clients: c };
}

function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return ['Password must be at least 10 characters.'];
  return [];
}

export async function createUser(settings, body, { at, actor }) {
  const access = resolveAccess(settings, body, actor);
  const errors = [...checkUserFields(settings, body, { creating: true }), ...access.errors, ...checkNewPassword(body.password)];
  if (errors.length) throw userError(400, errors.join(' '));
  const user = {
    id: randomUUID(),
    name: body.name.trim(),
    email: normaliseEmail(body.email),
    role: body.role,
    sites: access.sites,
    clients: access.clients,
    active: true,
    epoch: 1,
    passwordHash: await hashPassword(body.password),
    createdAt: at,
  };
  return {
    settings: { ...settings, users: [...settings.users, user] },
    user,
    clients: clientsOfUser(settings, user),
    message: `User ${user.email} added as ${user.role.replace('_', ' ')}`,
  };
}

const sameList = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// `actor` is the signed-in principal, so an admin cannot lock themselves out
// and a client admin cannot reach beyond their clients.
export async function updateUser(settings, id, body, { at, actor }) {
  const user = findUser(settings, id);
  if (!user) throw userError(404, 'User not found.');
  const self = actor.kind === 'user' && actor.userId === id;
  if (!self && !canManageUser(actor, user, settings)) throw userError(403, 'You cannot change this user.');
  const errors = checkUserFields(settings, body, { selfId: id });
  const accessTouched = body.role !== undefined || body.sites !== undefined || body.clients !== undefined;
  const access = accessTouched
    ? resolveAccess(settings, {
      role: body.role ?? user.role,
      // A former admin's access to every site is not carried over.
      sites: body.sites ?? (user.role === 'admin' && body.role && body.role !== 'admin' ? [] : user.sites),
      clients: body.clients ?? user.clients,
    }, actor)
    : { errors: [], sites: user.sites, clients: user.clients };
  errors.push(...access.errors);
  if (body.password !== undefined) errors.push(...checkNewPassword(body.password));
  if (self && body.active === false) errors.push('You cannot disable your own account.');
  if (self && body.role !== undefined && body.role !== user.role && ['admin', 'client_admin'].includes(user.role)) errors.push('You cannot change your own role.');
  if (self && accessTouched && user.role === 'client_admin' && !sameList(access.clients, user.clients)) errors.push('You cannot change your own clients.');
  // Someone must always be able to manage the install.
  const staysAdmin = (body.role ?? user.role) === 'admin' && (body.active === undefined ? user.active : Boolean(body.active));
  if (user.role === 'admin' && user.active && !staysAdmin && activeAdmins(settings).length === 1) {
    errors.push(`${user.name} is the only active admin. Make someone else an admin first.`);
  }
  if (errors.length) throw userError(400, errors.join(' '));

  const next = { ...user };
  const changed = [];
  if (body.name !== undefined && body.name.trim() !== user.name) { next.name = body.name.trim(); changed.push('name'); }
  if (body.email !== undefined && normaliseEmail(body.email) !== user.email) { next.email = normaliseEmail(body.email); changed.push('email'); }
  if (body.role !== undefined && body.role !== user.role) { next.role = body.role; changed.push('role'); }
  if (!sameList(access.sites, user.sites)) { next.sites = access.sites; changed.push('sites'); }
  if (!sameList(access.clients, user.clients)) { next.clients = access.clients; changed.push('clients'); }
  if (body.active !== undefined && Boolean(body.active) !== user.active) { next.active = Boolean(body.active); changed.push(next.active ? 'enabled' : 'disabled'); }
  if (body.password !== undefined) { next.passwordHash = await hashPassword(body.password); changed.push('password'); }
  // Any change to access, or a new password, ends that user's open sessions.
  if (changed.some((c) => ['role', 'sites', 'clients', 'disabled', 'password', 'email'].includes(c))) next.epoch = (user.epoch ?? 1) + 1;
  if (changed.length) next.updatedAt = at;

  return {
    settings: { ...settings, users: settings.users.map((u) => (u.id === id ? next : u)) },
    user: next,
    changed,
    clients: [...new Set([...clientsOfUser(settings, user), ...clientsOfUser(settings, next)])],
    message: changed.length ? `User ${next.email} changed: ${changed.join(', ')}` : '',
  };
}

export function deleteUser(settings, id, { actor }) {
  const user = findUser(settings, id);
  if (!user) throw userError(404, 'User not found.');
  if (actor.kind === 'user' && actor.userId === id) throw userError(400, 'You cannot delete your own account.');
  if (!canManageUser(actor, user, settings)) throw userError(403, 'You cannot delete this user.');
  if (user.role === 'admin' && user.active && activeAdmins(settings).length === 1) throw userError(400, `${user.name} is the only active admin. Make someone else an admin first.`);
  return {
    settings: { ...settings, users: settings.users.filter((u) => u.id !== id) },
    clients: clientsOfUser(settings, user),
    message: `User ${user.email} deleted`,
  };
}

// ---- Clients

export function publicClient(client, settings) {
  const sites = settings.sites.filter((x) => x.clientId === client.id);
  return {
    id: client.id, name: client.name, active: client.active, createdAt: client.createdAt ?? null,
    sites: sites.length, activeSites: sites.filter((x) => x.active).length,
  };
}

export function createClient(settings, body, { at }) {
  const name = String(body.name ?? '').trim();
  const id = slug(body.id ?? name);
  const errors = [];
  if (!name) errors.push('Enter the client name.');
  else if (!SITE_ID.test(id)) errors.push('The client name needs at least two letters or digits.');
  else if (findClient(settings, id)) errors.push(`A client called ${name} already exists.`);
  if (errors.length) throw userError(400, errors.join(' '));
  const client = { id, name, active: true, createdAt: at };
  return { settings: { ...settings, clients: [...settings.clients, client] }, client, message: `Client ${name} added` };
}

export function updateClient(settings, id, body, { at, actor }) {
  const client = findClient(settings, id);
  if (!client) throw userError(404, 'Client not found.');
  if (!canManageClient(actor, id)) throw userError(403, 'You cannot change this client.');
  const next = { ...client };
  const changed = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw userError(400, 'Enter the client name.');
    if (name !== client.name) { next.name = name; changed.push('name'); }
  }
  if (body.active !== undefined && Boolean(body.active) !== client.active) {
    if (actor.role !== 'admin') throw userError(403, 'Only an admin can archive or reopen a client.');
    const othersLive = settings.sites.some((x) => x.clientId !== id && siteLive(settings, x));
    if (!body.active && !othersLive) throw userError(400, 'At least one site must stay active: this client holds the only active sites.');
    next.active = Boolean(body.active);
    changed.push(next.active ? 'reopened' : 'archived');
  }
  if (changed.length) next.updatedAt = at;
  return {
    settings: { ...settings, clients: settings.clients.map((c) => (c.id === id ? next : c)) },
    client: next,
    message: changed.length ? `Client ${next.name} changed: ${changed.join(', ')}` : '',
  };
}

// Only an empty client can be deleted. Users lose access to it; anyone left
// with no access at all is disabled rather than given access by default.
export function deleteClient(settings, id) {
  const client = findClient(settings, id);
  if (!client) throw userError(404, 'Client not found.');
  if (settings.sites.some((x) => x.clientId === id)) throw userError(400, `${client.name} still has sites. Move them to another client, or archive the client instead.`);
  const users = settings.users.map((u) => {
    if (!u.clients.includes(id)) return u;
    const clients = u.clients.filter((c) => c !== id);
    const empty = !clients.length && !u.sites.length && u.role !== 'admin';
    return { ...u, clients, active: empty ? false : u.active, epoch: (u.epoch ?? 1) + 1 };
  });
  return {
    settings: { ...settings, clients: settings.clients.filter((c) => c.id !== id), users },
    message: `Client ${client.name} deleted`,
  };
}

// ---- Sites

export function publicSite(site, settings, { full = false } = {}) {
  const fp = site.floorPlan ?? {};
  const client = findClient(settings, site.clientId);
  const out = {
    id: site.id,
    name: site.name,
    clientId: site.clientId,
    clientName: client?.name ?? '',
    active: site.active,
    live: siteLive(settings, site),
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

export function createSite(settings, body, { at, actor }) {
  const id = String(body.id ?? '').trim().toLowerCase();
  const name = String(body.name ?? '').trim();
  const clientId = String(body.clientId ?? '');
  const errors = [];
  if (!SITE_ID.test(id)) errors.push('Site code must be 2 to 40 lower-case letters, digits or hyphens.');
  else if (findSite(settings, id)) errors.push(`A site with code ${id} already exists.`);
  if (!name) errors.push('Enter the site name.');
  if (!findClient(settings, clientId)) errors.push('Choose the client this site belongs to.');
  else if (!canManageClient(actor, clientId)) errors.push('You can only add sites to your own clients.');
  if (errors.length) throw userError(400, errors.join(' '));
  const site = newSite({ id, name, clientId, at });
  return {
    settings: { ...settings, sites: [...settings.sites, site] },
    site,
    message: `Site ${name} (${id}) added to ${findClient(settings, clientId).name}`,
  };
}

export function updateSite(settings, id, body, { at, actor }) {
  const site = findSite(settings, id);
  if (!site) throw userError(404, 'Site not found.');
  if (!canManageSite(actor, site)) throw userError(403, 'You cannot change this site.');
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
  if (body.clientId !== undefined && body.clientId !== site.clientId) {
    const to = findClient(settings, body.clientId);
    if (!to) throw userError(400, 'Unknown client.');
    if (!canManageClient(actor, to.id)) throw userError(403, 'You can only move a site to one of your own clients.');
    next.clientId = to.id;
    changed.push(`moved to ${to.name}`);
  }
  if (body.active !== undefined && Boolean(body.active) !== site.active) {
    if (!body.active && settings.sites.filter((x) => x.id !== id && siteLive(settings, x)).length === 0) throw userError(400, 'At least one site must stay active.');
    next.active = Boolean(body.active);
    changed.push(next.active ? 'reopened' : 'archived');
  }
  if (changed.length) next.updatedAt = at;
  return {
    settings: { ...settings, sites: settings.sites.map((x) => (x.id === id ? next : x)) },
    site: next,
    changed,
    clients: [...new Set([site.clientId, next.clientId])],
    message: changed.length ? `Site ${next.name} (${id}) changed: ${changed.join(', ')}` : '',
  };
}
