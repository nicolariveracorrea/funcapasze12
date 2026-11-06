const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');

function run(database, sql, params = []) {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (error) => error ? reject(error) : resolve());
  });
}

function openDatabase(filePath) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(filePath, (error) => error ? reject(error) : resolve(database));
  });
}

function closeDatabase(database) {
  return new Promise((resolve, reject) => {
    database.close((error) => error ? reject(error) : resolve());
  });
}

function runScript(scriptPath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, output }));
  });
}

test('database backup and restore are verified and preserve the pre-restore database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'funcapaze-backup-test-'));
  const dataDir = path.join(root, 'data');
  const backupDir = path.join(root, 'backups');
  await fs.mkdir(dataDir, { recursive: true });
  const livePath = path.join(dataDir, 'funcapaze.db');
  const database = await openDatabase(livePath);

  await run(database, 'CREATE TABLE clientes (id TEXT PRIMARY KEY)');
  await run(database, 'CREATE TABLE reservas (id TEXT PRIMARY KEY)');
  await run(database, 'CREATE TABLE recompensas (id TEXT PRIMARY KEY)');
  await run(database, 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await run(database, 'INSERT INTO settings (key, value) VALUES (?, ?)', ['precio_hora', '100000']);
  await closeDatabase(database);

  const env = { ...process.env, DATA_DIR: dataDir, BACKUP_DIR: backupDir };
  const backupResult = await runScript(path.join(__dirname, '..', 'scripts', 'backup-db.js'), [], env);
  assert.equal(backupResult.code, 0, backupResult.output);
  const backupFiles = (await fs.readdir(backupDir)).filter((file) => file.endsWith('.sqlite'));
  assert.equal(backupFiles.length, 1);
  const backupPath = path.join(backupDir, backupFiles[0]);

  const changedDatabase = await openDatabase(livePath);
  await run(changedDatabase, 'UPDATE settings SET value = ? WHERE key = ?', ['250000', 'precio_hora']);
  await closeDatabase(changedDatabase);

  const restoreResult = await runScript(
    path.join(__dirname, '..', 'scripts', 'restore-db.js'),
    [backupPath, '--confirm-database-stopped'],
    env
  );
  assert.equal(restoreResult.code, 0, restoreResult.output);

  const restoredDatabase = await openDatabase(livePath);
  const restoredSetting = await new Promise((resolve, reject) => {
    restoredDatabase.get('SELECT value FROM settings WHERE key = ?', ['precio_hora'], (error, row) => error ? reject(error) : resolve(row));
  });
  await closeDatabase(restoredDatabase);
  assert.equal(restoredSetting.value, '100000');
  assert.equal((await fs.readdir(backupDir)).filter((file) => file.startsWith('before-restore-')).length, 1);

  t.after(() => fs.rm(root, { recursive: true, force: true }));
});
