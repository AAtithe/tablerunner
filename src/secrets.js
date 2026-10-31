import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Secrets the service must read back, such as the SevenRooms client secret,
// cannot be hashed like passwords. They are stored encrypted with AES-256-GCM
// under a key held in Vercel, never in Redis, so a copy of the database on its
// own does not reveal them. Each value is bound to its field name, so an
// encrypted value cannot be moved into another field.
//
// The key is only needed once SevenRooms credentials are entered. Without it
// the service runs in shadow mode as before.

export const SECRET_KEY_VAR = 'TABLE_RUNNER_SECRET_KEY';
export const SECRET_KEY_MIN_LENGTH = 32;
const PREFIX = 'enc1';

// Returns the 32-byte key, or null if the variable is missing or too short.
export function secretKeyFromEnv(env) {
  const raw = env[SECRET_KEY_VAR];
  if (typeof raw !== 'string' || raw.trim().length < SECRET_KEY_MIN_LENGTH) return null;
  return createHash('sha256').update(raw.trim()).digest();
}

export const isEncrypted = (stored) => typeof stored === 'string' && stored.startsWith(`${PREFIX}.`);

export function encryptSecret(plain, key, field) {
  if (!key) throw new Error(`${SECRET_KEY_VAR} is not set`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(field));
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function decryptSecret(stored, key, field) {
  if (!isEncrypted(stored)) throw new Error('it was saved before secrets were encrypted. Enter it again on the Settings screen');
  if (!key) throw new Error(`${SECRET_KEY_VAR} is not set in Vercel`);
  const [, iv, tag, body] = stored.split('.').map((p, i) => (i ? Buffer.from(p, 'base64url') : p));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(field));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new Error(`it cannot be read with the current ${SECRET_KEY_VAR}. If the key was changed, enter it again on the Settings screen`);
  }
}

// Why a stored secret cannot be used, or null if it can. Never returns the value.
export function secretProblem(stored, key, field) {
  if (!stored) return null;
  try {
    decryptSecret(stored, key, field);
    return null;
  } catch (err) {
    return err.message;
  }
}
