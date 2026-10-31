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

// ---- Postmark tokens

const { encryptPlainTokens, rotateEncryptionKey, MAIL_TOKEN_FIELD, POSTMARK_TOKEN_FIELD, CLIENT_SECRET_FIELD } = await import('../src/settings.js');

const plainSettings = () => ({
  mail: { from: 'tr@ws.co', serverToken: 'pm-send' },
  sites: [
    { id: 'a', postmark: { serverToken: 'pm-site-a', serverName: 'A' }, sevenRooms: { clientSecret: '' } },
    { id: 'b', sevenRooms: { clientSecret: '' } },
  ],
});

test('Postmark tokens saved in plain text are encrypted in place, each bound to its own field', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const r = encryptPlainTokens(plainSettings(), ring);
  assert.equal(r.count, 2);
  const mail = r.settings.mail.serverToken;
  const site = r.settings.sites[0].postmark.serverToken;
  assert.ok(isEncrypted(mail) && isEncrypted(site));
  assert.equal(JSON.stringify(r.settings).includes('pm-send') || JSON.stringify(r.settings).includes('pm-site-a'), false);
  assert.equal(decryptSecret(mail, ring, MAIL_TOKEN_FIELD), 'pm-send');
  assert.equal(decryptSecret(site, ring, POSTMARK_TOKEN_FIELD), 'pm-site-a');
  assert.throws(() => decryptSecret(mail, ring, POSTMARK_TOKEN_FIELD), /cannot be decrypted/, 'cannot be swapped between fields');
  assert.equal(r.settings.sites[0].postmark.serverName, 'A', 'other fields kept');
  // Nothing left to do the second time.
  assert.equal(encryptPlainTokens(r.settings, ring), null);
  assert.equal(encryptPlainTokens({ sites: [] }, ring), null);
});

test('a key rotation re-encrypts both Postmark tokens and the SevenRooms secret', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const s = encryptPlainTokens(plainSettings(), ring).settings;
  s.sites[1].sevenRooms.clientSecret = encryptSecret('s3cret', ring, CLIENT_SECRET_FIELD);
  const r = rotateEncryptionKey(s, ring, '2026-11-01');
  assert.deepEqual(r.counts, { sevenRooms: 1, postmark: 1, mail: 1 });
  const pruned = pruneKeyring(r.keyring);
  for (const [stored, field, plain] of [
    [r.settings.mail.serverToken, MAIL_TOKEN_FIELD, 'pm-send'],
    [r.settings.sites[0].postmark.serverToken, POSTMARK_TOKEN_FIELD, 'pm-site-a'],
    [r.settings.sites[1].sevenRooms.clientSecret, CLIENT_SECRET_FIELD, 's3cret'],
  ]) {
    assert.equal(stored.split('.')[1], r.keyring.current);
    assert.equal(decryptSecret(stored, pruned, field), plain, 'readable once the old key is gone');
  }
});

test('a rotation encrypts a Postmark token still in plain text and leaves an unreadable one as it is', async () => {
  const ring = await loadKeyring(new FakeRedis());
  const other = await loadKeyring(new FakeRedis());
  const s = plainSettings();
  s.sites[1].postmark = { serverToken: encryptSecret('lost', other, POSTMARK_TOKEN_FIELD) };
  const r = rotateEncryptionKey(s, ring, '2026-11-01');
  assert.deepEqual(r.counts, { sevenRooms: 0, postmark: 1, mail: 1 });
  assert.equal(decryptSecret(r.settings.mail.serverToken, r.keyring, MAIL_TOKEN_FIELD), 'pm-send');
  assert.equal(r.settings.sites[1].postmark.serverToken, s.sites[1].postmark.serverToken);
});
