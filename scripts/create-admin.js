const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const sqlite3 = require('sqlite3').verbose();

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'funcapaze.db');

const run = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (error) {
    if (error) return reject(error);
    resolve({ id: this.lastID, changes: this.changes });
  });
});

const get = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => {
    if (error) return reject(error);
    resolve(row || null);
  });
});

const all = (db, sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => {
    if (error) return reject(error);
    resolve(rows || []);
  });
});

function promptHidden(message) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('Run this command directly in a terminal to enter the password securely.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(message);
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      const character = chunk.toString('utf8');
      if (character === '\u0003') {
        finish(new Error('Operación cancelada.'));
      } else if (character === '\r' || character === '\n') {
        finish();
      } else if (character === '\u007f' || character === '\b') {
        value = value.slice(0, -1);
      } else if (!/[\u0000-\u001f\u007f]/.test(character)) {
        value += character;
      }
    };

    input.on('data', onData);
  });
}

async function main() {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite3.Database(dbPath, (error) => error ? reject(error) : resolve(connection));
  });

  try {
    await run(db, `
      CREATE TABLE IF NOT EXISTS clientes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL UNIQUE,
        username TEXT UNIQUE,
        passwordHash TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'cliente',
        activo INTEGER NOT NULL DEFAULT 1,
        sessionVersion INTEGER NOT NULL DEFAULT 1
      )
    `);
    const columns = await all(db, 'PRAGMA table_info(clientes)');
    if (!columns.some((column) => column.name === 'activo')) {
      await run(db, 'ALTER TABLE clientes ADD COLUMN activo INTEGER NOT NULL DEFAULT 1');
    }
    if (!columns.some((column) => column.name === 'username')) {
      await run(db, 'ALTER TABLE clientes ADD COLUMN username TEXT');
    }
    if (!columns.some((column) => column.name === 'sessionVersion')) {
      await run(db, 'ALTER TABLE clientes ADD COLUMN sessionVersion INTEGER NOT NULL DEFAULT 1');
    }
    await run(db, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_username ON clientes(username)');

    const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
    const usernameInput = process.env.ADMIN_USERNAME || await terminal.question('Usuario administrador: ');
    const phoneInput = await terminal.question('Teléfono de contacto (10 dígitos): ');
    terminal.close();
    const username = usernameInput.trim().toLowerCase();
    const phone = phoneInput.replace(/\D/g, '').slice(-10);
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) {
      throw new Error('El usuario debe tener 3-64 caracteres: letras, números, punto, guion o guion bajo.');
    }
    if (phone.length !== 10) {
      throw new Error('El teléfono debe tener 10 dígitos.');
    }

    const password = await promptHidden('Contraseña (mínimo 12 caracteres, no se mostrará): ');
    if (password.length < 12 || password.length > 128) {
      throw new Error('La contraseña debe tener entre 12 y 128 caracteres.');
    }

    const existingByUsername = await get(db, 'SELECT id, role FROM clientes WHERE username = ?', [username]);
    const existingByPhone = await get(db, 'SELECT id, role FROM clientes WHERE phone = ?', [phone]);
    const existing = existingByUsername || existingByPhone;
    if (existing && (existing.role !== 'admin' || (existingByUsername && existingByPhone && existingByUsername.id !== existingByPhone.id))) {
      throw new Error('El usuario o teléfono pertenece a otra cuenta. No se modificó ninguna cuenta.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    if (existing) {
      await run(db, 'UPDATE clientes SET username = ?, passwordHash = ?, activo = 1, sessionVersion = sessionVersion + 1 WHERE id = ?', [username, passwordHash, existing.id]);
    } else {
      await run(
        'INSERT INTO clientes (id, name, phone, username, passwordHash, createdAt, role, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`adm_${crypto.randomUUID()}`, 'Administrador', phone, username, passwordHash, new Date().toISOString(), 'admin', 1]
      );
    }

    console.log('Cuenta administradora lista. Usa el usuario y la contraseña que acabas de ingresar.');
    console.log(`Base de datos: ${dbPath}`);
  } finally {
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});