const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { encryptFile } = require('./backup-crypto');
const { readGoogleDriveConfig, getAccessToken, uploadFile, listBackupFiles, deleteFile } = require('./google-drive');

const appRoot = path.join(__dirname, '..');
const backupCommand = path.join(__dirname, 'backup-db.js');

async function runLocalBackup(tempDir) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [backupCommand], {
      cwd: appRoot,
      env: { ...process.env, BACKUP_DIR: tempDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output || `Local backup exited with code ${code}.`)));
  }).then(async (output) => {
    const match = output.match(/Backup created and verified: (.+)/);
    if (!match) throw new Error('Local backup command did not return a verified backup path.');
    return match[1].trim();
  });
}

async function main() {
  const { credentials, folderId, encryptionKey } = readGoogleDriveConfig();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'funcapaze-drive-backup-'));
  fs.chmodSync(tempDir, 0o700);
  try {
    const plainBackup = await runLocalBackup(tempDir);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const encryptedPath = path.join(tempDir, `funcapaze-${timestamp}.sqlite.aesgcm`);
    await encryptFile(plainBackup, encryptedPath, encryptionKey);
    const accessToken = await getAccessToken(credentials);
    const driveFileId = await uploadFile(encryptedPath, path.basename(encryptedPath), folderId, accessToken);
    console.log(`Encrypted backup uploaded to Google Drive. File ID: ${driveFileId}`);

    // Retención: conserva solo las últimas BACKUP_RETENTION_COUNT copias cifradas y borra las antiguas.
    const retention = Number(process.env.BACKUP_RETENTION_COUNT || 14);
    if (!Number.isInteger(retention) || retention < 1) {
      throw new Error('BACKUP_RETENTION_COUNT must be a positive integer.');
    }
    const allFiles = await listBackupFiles(folderId, accessToken);
    const backups = allFiles.filter((file) => file.name.endsWith('.aesgcm'));
    for (const expired of backups.slice(retention)) {
      await deleteFile(expired.id, accessToken);
      console.log(`Deleted expired backup: ${expired.name} (File ID: ${expired.id})`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
