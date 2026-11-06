const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { decryptFile } = require('./backup-crypto');
const { readGoogleDriveConfig, getAccessToken, downloadFile } = require('./google-drive');

const restoreCommand = path.join(__dirname, 'restore-db.js');

function runLocalRestore(databaseBackupPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [restoreCommand, databaseBackupPath, '--confirm-database-stopped'], {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output || `Local restore exited with code ${code}.`)));
  });
}

async function main() {
  const [fileId, confirmation] = process.argv.slice(2);
  if (!fileId || confirmation !== '--confirm-database-stopped') {
    throw new Error('Usage: node scripts/restore-drive.js <google-drive-file-id> --confirm-database-stopped');
  }

  const { credentials, encryptionKey } = readGoogleDriveConfig();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funcapaze-drive-restore-'));
  fs.chmodSync(tempDir, 0o700);
  const encryptedPath = path.join(tempDir, 'remote-backup.sqlite.aesgcm');
  const databaseBackupPath = path.join(tempDir, 'restored-backup.sqlite');

  try {
    const accessToken = await getAccessToken(credentials);
    await downloadFile(fileId, encryptedPath, accessToken);
    await decryptFile(encryptedPath, databaseBackupPath, encryptionKey);
    const output = await runLocalRestore(databaseBackupPath);
    process.stdout.write(output);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
