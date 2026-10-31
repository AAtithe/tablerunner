import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Secrets the service must read back, such as the SevenRooms client secret,
// cannot be hashed like passwords. They are stored encrypted with AES-256-GCM.
// Each value is bound to its field name, so it cannot be moved into another
// field.
//
// The keys are created and rotated by the app, from the Settings screen, and
// kept in Redis apart from the settings. Nothing is set in Vercel. This keeps
// the secret out of the settings record, the Settings screen, the activity log
// and any copy of the settings, but anyone who can read the whole database can
// read the key too.
//
// The keyring holds the current key and, during a rotation, older ones, so a
// secret can always be read while it is re-encrypted.

const KEYRING_KEY = 'tr:keyring';
const PREFIX = 'enc1';

export const newKey = (created) => ({ id: randomBytes(6).toString('base64url'), key: randomBytes(32).toString('base64url'), created });

// Loads the keyring, creating it the first time.
export async function loadKeyring(redis, { now = () => new Date().toISOString() } = {}) {
  let raw = await redis.cmd('GET', KEYRING_KEY);
  if (!raw) {
    const k = newKey(now());
    await redis.cmd('SET', KEYRING_KEY, JSON.stringify({ current: k.id, keys: { [k.id]: k } }), 'NX');
    raw = await redis.cmd('GET', KEYRING_KEY);
  }
  return JSON.parse(raw);
}

export async function saveKeyring(redis, keyring) {
  await redis.cmd('SET', KEYRING_KEY, JSON.stringify(keyring));
}

// A new current key, keeping the old ones until secrets are re-encrypted.
export function addKey(keyring, created) {
  const k = newKey(created);
  return { current: k.id, keys: { ...keyring.keys, [k.id]: k } };
}

// Drops every key but the current one, once nothing uses them.
export const pruneKeyring = (keyring) => ({ current: keyring.current, keys: { [keyring.current]: keyring.keys[keyring.current] } });

export const currentKeyInfo = (keyring) => ({ id: keyring.current, created: keyring.keys[keyring.current].created });

export const isEncrypted = (stored) => typeof stored === 'string' && stored.startsWith(`${PREFIX}.`);

export function encryptSecret(plain, keyring, field) {
  const { id, key } = keyring.keys[keyring.current];
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(Buffer.from(field));
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, id, ...[iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url'))].join('.');
}

export function decryptSecret(stored, keyring, field) {
  if (!isEncrypted(stored)) throw new Error('it was saved before secrets were encrypted. Enter it again on the Settings screen');
  const [, id, iv, tag, body] = stored.split('.');
  const entry = keyring.keys[id];
  if (!entry) throw new Error('its encryption key no longer exists. Enter it again on the Settings screen');
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(entry.key, 'base64url'), Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(field));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('it cannot be decrypted. Enter it again on the Settings screen');
  }
}

// Why a stored secret cannot be used, or null if it can. Never returns the value.
export function secretProblem(stored, keyring, field) {
  if (!stored) return null;
  try {
    decryptSecret(stored, keyring, field);
    return null;
  } catch (err) {
    return err.message;
  }
}
