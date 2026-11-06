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
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Database not found: ${databasePath}`);
  }
  await validateDatabase(databasePath);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `funcapaze-${timestamp}.sqlite`);
  await createBackup(databasePath, backupPath);
  fs.chmodSync(backupPath, 0o600);
  await validateDatabase(backupPath);
  console.log(`Backup created and verified: ${backupPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
