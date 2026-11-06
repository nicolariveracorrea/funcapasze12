const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const databasePath = path.join(dataDir, 'funcapaze.db');
const backupDir = process.env.BACKUP_DIR || path.join(dataDir, 'backups');

function openDatabase(filePath, flags) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, flags, (error) => {
      if (error) return reject(error);
      resolve(database);
    });
  });
}

function get(database, sql) {
  return new Promise((resolve, reject) => {
    database.get(sql, (error, row) => error ? reject(error) : resolve(row || null));
  });
}

function all(database, sql) {
  return new Promise((resolve, reject) => {
    database.all(sql, (error, rows) => error ? reject(error) : resolve(rows || []));
  });
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve());
  });
}

async function validateDatabase(filePath) {
  const database = await openDatabase(filePath, sqlite3.OPEN_READONLY);
  try {
    const integrity = await get(database, 'PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') {
      throw new Error(`SQLite integrity check failed for ${filePath}.`);
    }
    const tables = await all(database, "SELECT name FROM sqlite_master WHERE type = 'table'");
    const tableNames = new Set(tables.map((table) => table.name));
    for (const requiredTable of ['clientes', 'reservas', 'recompensas']) {
      if (!tableNames.has(requiredTable)) {
        throw new Error(`Database is missing required table: ${requiredTable}.`);
      }
    }
  } finally {
    await closeDatabase(database);
  }
}

async function createBackup(sourcePath, backupPath) {
  const source = await openDatabase(sourcePath, sqlite3.OPEN_READONLY);
  try {
    await new Promise((resolve, reject) => {
      const backup = source.backup(backupPath);
      backup.step(-1, (stepError) => {
        backup.finish((finishError) => {
          if (stepError) return reject(stepError);
          if (finishError) return reject(finishError);
          return resolve();
        });
      });
    });
  } finally {
    await closeDatabase(source);
  }
}

async function main() {
  const [backupArgument, confirmation] = process.argv.slice(2);
  if (!backupArgument || confirmation !== '--confirm-database-stopped') {
    throw new Error('Usage: node scripts/restore-db.js <verified-backup.sqlite> --confirm-database-stopped');
  }

  const backupPath = path.resolve(backupArgument);
  if (!fs.existsSync(backupPath) || path.resolve(databasePath) === backupPath) {
    throw new Error('Provide an existing backup file distinct from the live database.');
  }
  await validateDatabase(backupPath);
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Live database not found: ${databasePath}`);
  }
  await validateDatabase(databasePath);

  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyPath = path.join(backupDir, `before-restore-${timestamp}.sqlite`);
  await createBackup(databasePath, safetyPath);
  fs.chmodSync(safetyPath, 0o600);
  await validateDatabase(safetyPath);

  const temporaryPath = `${databasePath}.restore-${process.pid}.tmp`;
  try {
    fs.copyFileSync(backupPath, temporaryPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(temporaryPath, 0o600);
    await validateDatabase(temporaryPath);
    fs.renameSync(temporaryPath, databasePath);
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }

  console.log(`Database restored and verified. Previous database preserved at: ${safetyPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
