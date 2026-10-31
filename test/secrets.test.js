import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, secretKeyFromEnv, secretProblem, isEncrypted } from '../src/secrets.js';

const key = secretKeyFromEnv({ TABLE_RUNNER_SECRET_KEY: 'k'.repeat(32) });
const other = secretKeyFromEnv({ TABLE_RUNNER_SECRET_KEY: 'x'.repeat(32) });
const FIELD = 'sevenRooms.clientSecret';

test('a secret round-trips and is never stored as written', () => {
  const a = encryptSecret('s3cret', key, FIELD);
  const b = encryptSecret('s3cret', key, FIELD);
  assert.ok(isEncrypted(a));
  assert.equal(a.includes('s3cret'), false);
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.equal(decryptSecret(a, key, FIELD), 's3cret');
});

test('the key must be set and at least 32 characters', () => {
  assert.equal(secretKeyFromEnv({}), null);
  assert.equal(secretKeyFromEnv({ TABLE_RUNNER_SECRET_KEY: 'short' }), null);
  assert.throws(() => encryptSecret('s3cret', null, FIELD), /not set/);
});

test('a wrong key, another field, tampering or plain text are all refused', () => {
  const stored = encryptSecret('s3cret', key, FIELD);
  assert.throws(() => decryptSecret(stored, other, FIELD), /cannot be read/);
  assert.throws(() => decryptSecret(stored, key, 'other.field'), /cannot be read/);
  const parts = stored.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), key, FIELD), /cannot be read/);
  assert.throws(() => decryptSecret('s3cret', key, FIELD), /before secrets were encrypted/);
  assert.throws(() => decryptSecret(stored, null, FIELD), /not set/);
});

test('secretProblem explains without revealing the value', () => {
  assert.equal(secretProblem('', key, FIELD), null);
  assert.equal(secretProblem(encryptSecret('s3cret', key, FIELD), key, FIELD), null);
  const problem = secretProblem(encryptSecret('s3cret', key, FIELD), other, FIELD);
  assert.match(problem, /cannot be read/);
  assert.equal(problem.includes('s3cret'), false);
});
