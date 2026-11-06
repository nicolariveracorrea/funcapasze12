const crypto = require('crypto');
const fs = require('fs');
const { pipeline } = require('stream/promises');

const MAGIC = Buffer.from('FNCPBK01');

function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Backup encryption key must be exactly 32 bytes.');
  }
}

async function encryptFile(sourcePath, encryptedPath, key) {
  validateKey(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const output = fs.createWriteStream(encryptedPath, { flags: 'wx', mode: 0o600 });
  try {
    output.write(Buffer.concat([MAGIC, iv]));
    await pipeline(fs.createReadStream(sourcePath), cipher, output);
    fs.appendFileSync(encryptedPath, cipher.getAuthTag(), { mode: 0o600 });
  } catch (error) {
    if (fs.existsSync(encryptedPath)) fs.unlinkSync(encryptedPath);
    throw error;
  }
}

async function decryptFile(encryptedPath, destinationPath, key) {
  validateKey(key);
  const size = fs.statSync(encryptedPath).size;
  if (size < MAGIC.length + 12 + 16) {
    throw new Error('Encrypted backup is too short.');
  }

  const file = fs.openSync(encryptedPath, 'r');
  const header = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  try {
    fs.readSync(file, header, 0, header.length, 0);
    fs.readSync(file, tag, 0, tag.length, size - tag.length);
  } finally {
    fs.closeSync(file);
  }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Encrypted backup format is not recognized.');
  }

  const iv = header.subarray(MAGIC.length);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      fs.createReadStream(encryptedPath, { start: header.length, end: size - tag.length - 1 }),
      decipher,
      fs.createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 })
    );
  } catch (error) {
    if (fs.existsSync(destinationPath)) fs.unlinkSync(destinationPath);
    throw new Error('Backup decryption/authentication failed. Check BACKUP_ENCRYPTION_KEY and file integrity.');
  }
}

module.exports = { encryptFile, decryptFile };
