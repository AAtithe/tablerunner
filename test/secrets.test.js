import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeRedis } from './fake-redis.js';
import {
  addKey, decryptSecret, encryptSecret, isEncrypted, loadKeyring, pruneKeyring, secretProblem,
} from '../src/secrets.js';

const FIELD = 'sevenRooms.clientSecret';

test('the app creates its own key once and keeps it', async () => {
  const redis = new FakeRedis();
  const a = await loadKeyring(redis);
  const b = await loadKeyring(redis);
  assert.deepEqual(a, b);
  assert.equal(Buffer.from(a.keys[a.current].key, 'base64url').length, 32);
});

test('a secret round-trips and is never stored as written', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const a = encryptSecret('s3cret', ring, FIELD);
  const b = encryptSecret('s3cret', ring, FIELD);
  assert.ok(isEncrypted(a));
  assert.equal(a.includes('s3cret'), false);
  assert.notEqual(a, b, 'a fresh IV each time');
  assert.equal(decryptSecret(a, ring, FIELD), 's3cret');
});

test('another key, another field, tampering or plain text are all refused', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const other = await loadKeyring(new FakeRedis());
  const stored = encryptSecret('s3cret', ring, FIELD);
  assert.throws(() => decryptSecret(stored, other, FIELD), /no longer exists/);
  assert.throws(() => decryptSecret(stored, ring, 'other.field'), /cannot be decrypted/);
  const parts = stored.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'), ring, FIELD), /cannot be decrypted/);
  assert.throws(() => decryptSecret('s3cret', ring, FIELD), /before secrets were encrypted/);
});

test('during a rotation old secrets stay readable until the old key is dropped', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const old = encryptSecret('s3cret', ring, FIELD);
  const rotated = addKey(ring, '2026-11-01');
  assert.notEqual(rotated.current, ring.current);
  assert.equal(decryptSecret(old, rotated, FIELD), 's3cret');
  assert.match(secretProblem(old, pruneKeyring(rotated), FIELD), /no longer exists/);
  assert.equal(secretProblem(old, rotated, FIELD), null);
  assert.equal(secretProblem('', rotated, FIELD), null);
});
