import { createHash } from 'node:crypto';
import { randomSecret, userError, readSecret, MAIL_TOKEN_FIELD } from './settings.js';
import { encryptSecret } from './secrets.js';

// Outbound email through Postmark: invites to set a password, password
// reset links and a test message. One Postmark server token for the whole
// install, set on the Admin panel's Email tab. Postmark only sends from an
// address or domain verified in the Postmark account (Sender Signatures).
// The token is stored encrypted under the install keyring.
const API = 'https://api.postmarkapp.com';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const LINK_TTL_S = { invite: 7 * 24 * 60 * 60, reset: 60 * 60 };

function headers(token) {
  return { accept: 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': token };
}

// Checks a server token and returns the Postmark server's name.
export async function checkMailToken(token, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/server`, { headers: headers(token) });
  if (res.status === 401 || res.status === 422) {
    throw userError(400, 'Postmark did not accept that token. In Postmark, open the server, choose API Tokens, and copy the Server API token.');
  }
  if (!res.ok) throw userError(502, `Postmark could not be reached (status ${res.status}). Try again in a minute.`);
  return (await res.json()).Name ?? '';
}

export async function sendEmail(mail, { to, subject, html, text }, { fetchImpl = fetch, keyring }) {
  if (!mail?.serverToken) throw userError(400, 'Email sending is not set up. An admin connects Postmark on the Admin panel, Email tab.');
  const token = readSecret(mail.serverToken, keyring, MAIL_TOKEN_FIELD, 'Paste the token again on the Admin panel, Email tab.');
  const from = mail.fromName ? `"${mail.fromName.replace(/"/g, '')}" <${mail.from}>` : mail.from;
  const res = await fetchImpl(`${API}/email`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({ From: from, To: to, Subject: subject, HtmlBody: html, TextBody: text, MessageStream: 'outbound' }),
  });
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok || (body.ErrorCode ?? 0) !== 0) {
    // 400 = sender not verified in Postmark; 406 = recipient inactive (bounced before).
    const hint = body.ErrorCode === 400 ? ` Verify ${mail.from} under Sender Signatures in Postmark.`
      : body.ErrorCode === 406 ? ' Postmark has stopped sending to this address after a bounce or spam complaint; reactivate it in Postmark.' : '';
    throw userError(502, `Postmark did not send the email: ${body.Message ?? `status ${res.status}`}.${hint}`);
  }
  return { messageId: body.MessageID };
}

// Applies a change to the install's email settings. Checks a new token with
// Postmark before anything is saved.
export async function applyMailChange(current = {}, patch, { origin, at, fetchImpl, keyring }) {
  if (patch.disconnect) return { mail: undefined, changed: ['email sending disconnected'] };
  const next = { ...current };
  const changed = [];
  const errors = [];
  if (patch.from !== undefined) {
    const v = String(patch.from).trim().toLowerCase();
    if (!EMAIL.test(v)) errors.push('Enter the address emails come from, for example tablerunner@williamsstanley.co.');
    else if (v !== current.from) { next.from = v; changed.push('from address'); }
  }
  if (patch.fromName !== undefined && String(patch.fromName).trim() !== (current.fromName ?? '')) {
    next.fromName = String(patch.fromName).trim().slice(0, 80);
    changed.push('from name');
  }
  if (patch.appUrl !== undefined) {
    const v = String(patch.appUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/]+$/.test(v)) errors.push('The address in emails must be the site address only, for example https://tablerunner.example.com.');
    else if (v !== current.appUrl) { next.appUrl = v; changed.push('address in emails'); }
  }
  if (!next.from && !errors.length) errors.push('Enter the address emails come from.');
  if (errors.length) throw userError(400, errors.join(' '));
  const token = typeof patch.serverToken === 'string' ? patch.serverToken.trim() : '';
  if (token) {
    next.serverName = await checkMailToken(token, fetchImpl);
    next.serverToken = encryptSecret(token, keyring, MAIL_TOKEN_FIELD);
    next.connectedAt = at;
    changed.push('Postmark sending connected');
  }
  if (!next.serverToken) throw userError(400, 'Paste the Postmark Server API token.');
  next.appUrl ??= origin;
  return { mail: next, changed };
}

export function publicMail(mail) {
  if (!mail?.serverToken) return { connected: false, from: mail?.from ?? '', fromName: mail?.fromName ?? 'Table Runner', appUrl: mail?.appUrl ?? '' };
  return {
    connected: true, from: mail.from, fromName: mail.fromName ?? '', appUrl: mail.appUrl,
    serverName: mail.serverName, connectedAt: mail.connectedAt, lastTestAt: mail.lastTestAt ?? null,
  };
}

// ---- One-time links (invite, password reset)
//
// The link carries a random token; Redis holds only its SHA-256, with an
// expiry. The token also names the user's current link nonce, so sending a
// new link, accepting one, or changing the user's email voids older links.

const key = (token) => `tr:link:${createHash('sha256').update(String(token)).digest('hex')}`;

export async function createLink(redis, { kind, userId, nonce }) {
  const token = randomSecret(32);
  await redis.cmd('SET', key(token), JSON.stringify({ kind, userId, nonce }), 'EX', LINK_TTL_S[kind]);
  return token;
}

export async function readLink(redis, token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const raw = await redis.cmd('GET', key(token));
  return raw ? JSON.parse(raw) : null;
}

export const deleteLink = (redis, token) => redis.cmd('DEL', key(token));

// ---- Messages

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ heading, paras, button, link, foot }) {
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f6f5f2;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f5f2;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e1db;border-radius:10px">
<tr><td style="padding:28px 28px 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#6b6a66;font-weight:600">Table Runner</td></tr>
<tr><td style="padding:0 28px;font-size:20px;font-weight:650;line-height:1.3">${esc(heading)}</td></tr>
${paras.map((p) => `<tr><td style="padding:14px 28px 0;font-size:15px;line-height:1.55">${esc(p)}</td></tr>`).join('')}
<tr><td style="padding:24px 28px 8px"><a href="${esc(link)}" style="display:inline-block;background:#1f4e79;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 20px;border-radius:8px">${esc(button)}</a></td></tr>
<tr><td style="padding:8px 28px 0;font-size:12px;line-height:1.5;color:#6b6a66">If the button does not work, copy this address into your browser:<br><span style="word-break:break-all;color:#1f4e79">${esc(link)}</span></td></tr>
<tr><td style="padding:20px 28px 28px;font-size:12px;line-height:1.5;color:#6b6a66">${esc(foot)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${heading}\n\n${paras.join('\n\n')}\n\n${button}: ${link}\n\n${foot}\n`;
  return { html, text };
}

const describeAccess = (access) => (access.length ? `You have access to ${access.join(', ')}.` : '');

export function inviteMessage({ name, email, inviter, access, link }) {
  const first = String(name).split(' ')[0];
  return {
    subject: 'You have been invited to Table Runner',
    ...layout({
      heading: `${first}, you have been invited to Table Runner`,
      paras: [
        `${inviter} has given you a Table Runner account. Table Runner shows the protected OpenTable tables at your venue, what has sold, what is released back to SevenRooms, and any booking that needs attention before service.`,
        describeAccess(access),
        `Set your password to start. You will sign in with ${email}.`,
      ].filter(Boolean),
      button: 'Set my password',
      link,
      foot: 'This link works once and expires in 7 days. If you were not expecting it, ignore this email and no account is activated.',
    }),
  };
}

export function resetMessage({ name, email, link }) {
  const first = String(name).split(' ')[0];
  return {
    subject: 'Reset your Table Runner password',
    ...layout({
      heading: `${first}, reset your password`,
      paras: [`Someone asked to reset the Table Runner password for ${email}. Choose a new password with the button below.`],
      button: 'Choose a new password',
      link,
      foot: 'This link works once and expires in 1 hour. If you did not ask for it, ignore this email: your password has not changed.',
    }),
  };
}

export function testMessage({ name, serverName, link }) {
  return {
    subject: 'Table Runner email test',
    ...layout({
      heading: 'Email sending works',
      paras: [`${name}, this test came from Table Runner through the Postmark server ${serverName}. Invites and password reset links will arrive the same way.`],
      button: 'Open Table Runner',
      link,
      foot: 'Sent from the Admin panel, Email tab.',
    }),
  };
}
