import { timingSafeEqual } from 'node:crypto';

export function safeEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accepts `Bearer <password>` (the dashboard) or HTTP Basic with any
// username (browsers, email providers that embed credentials in the URL).
export function passwordFromHeader(header = '') {
  const [scheme, token] = header.split(' ');
  if (!token) return null;
  if (scheme === 'Bearer') return token;
  if (scheme === 'Basic') return Buffer.from(token, 'base64').toString().split(':').slice(1).join(':');
  return null;
}

export function hasPassword(header, password) {
  return safeEqual(passwordFromHeader(header), password);
}
