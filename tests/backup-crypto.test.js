const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { encryptFile, decryptFile } = require('../scripts/backup-crypto');

test('encrypted backup round-trips and rejects the wrong key', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'funcapaze-backup-crypto-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const source = path.join(directory, 'source.sqlite');
  const encrypted = path.join(directory, 'backup.sqlite.aesgcm');
  const decrypted = path.join(directory, 'restored.sqlite');
  const wrongKeyOutput = path.join(directory, 'wrong-key.sqlite');
  const original = crypto.randomBytes(1024 * 64);
  const key = crypto.randomBytes(32);
  await fs.writeFile(source, original);

  await encryptFile(source, encrypted, key);
  await decryptFile(encrypted, decrypted, key);
  assert.deepEqual(await fs.readFile(decrypted), original);
  await assert.rejects(() => decryptFile(encrypted, wrongKeyOutput, crypto.randomBytes(32)), /decryption\/authentication failed/);
  await assert.rejects(() => fs.access(wrongKeyOutput));
});
