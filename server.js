const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const sqlite3 = require('sqlite3').verbose();
const { sendSms } = require('./sms');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const SESSION_COOKIE = 'funcapaze_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
let backupTimer = null;
let backupProcess = null;
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : crypto.randomBytes(32).toString('hex'));
if (JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.');
}

// ===== ADMIN DE DESARROLLO (opcional) =====
// Solo se aplica en desarrollo local si existe .dev-admin.json (ignorado por Git) y
// NO defines ADMIN_USERNAME / ADMIN_PHONE / ADMIN_PASSWORD como variables de entorno.
// En producción el administrador se crea EXCLUSIVAMENTE desde esas variables de entorno.
let FIXED_ADMIN = null;
try {
  const devCredentials = JSON.parse(fs.readFileSync(path.join(__dirname, '.dev-admin.json'), 'utf8'));
  if (devCredentials.username && devCredentials.phone && devCredentials.password) {
    FIXED_ADMIN = { username: String(devCredentials.username), phone: String(devCredentials.phone), password: String(devCredentials.password) };
  }
} catch {}
// =========================================

const dbDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(dbDir, 'funcapaze.db');

fs.mkdirSync(dbDir, { recursive: true });

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Database connection error:', err.message);
    process.exit(1);
  }
  console.log('Conectado a SQLite:', dbPath);
});

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) {
    if (err) return reject(err);
    resolve({ id: this.lastID, changes: this.changes });
  });
});

const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) return reject(err);
    resolve(row || null);
  });
});

const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) return reject(err);
    resolve(rows || []);
  });
});

// Las transacciones se ejecutan en una cola estricta para que peticiones concurrentes
// no intercalen BEGIN/COMMIT sobre la misma conexión SQLite ("cannot start a
// transaction within a transaction"). Las demás consultas siguen ejecutando en paralelo.
let transactionQueue = Promise.resolve();
function withTransaction(operation) {
  const task = transactionQueue.then(async () => {
    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await operation();
      await run('COMMIT');
      return result;
    } catch (error) {
      await run('ROLLBACK').catch(() => {});
      throw error;
    }
  });
  transactionQueue = task.catch(() => {});
  return task;
}

async function initDatabase() {
  await run('PRAGMA foreign_keys = ON');
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA busy_timeout = 5000');
  await run(`
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

  const clientColumns = await all('PRAGMA table_info(clientes)');
  if (!clientColumns.some((column) => column.name === 'activo')) {
    await run('ALTER TABLE clientes ADD COLUMN activo INTEGER NOT NULL DEFAULT 1');
  }
  if (!clientColumns.some((column) => column.name === 'username')) {
    await run('ALTER TABLE clientes ADD COLUMN username TEXT');
  }
  if (!clientColumns.some((column) => column.name === 'sessionVersion')) {
    await run('ALTER TABLE clientes ADD COLUMN sessionVersion INTEGER NOT NULL DEFAULT 1');
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_username ON clientes(username)');

  await run(`
    CREATE TABLE IF NOT EXISTS reservas (
      id TEXT PRIMARY KEY,
      clienteId TEXT,
      codigo TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      fecha TEXT NOT NULL,
      hora TEXT NOT NULL,
      cancha TEXT NOT NULL,
      sello TEXT NOT NULL,
      origen TEXT NOT NULL DEFAULT 'Manual Web',
      estado TEXT NOT NULL DEFAULT 'pendiente',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (clienteId) REFERENCES clientes(id)
    )
  `);

  const reservationColumns = await all('PRAGMA table_info(reservas)');
  if (!reservationColumns.some((column) => column.name === 'estado')) {
    await run("ALTER TABLE reservas ADD COLUMN estado TEXT NOT NULL DEFAULT 'pendiente'");
  }

  await run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS recompensas (
      id TEXT PRIMARY KEY,
      clienteId TEXT NOT NULL,
      reservaId TEXT NOT NULL UNIQUE,
      estado TEXT NOT NULL DEFAULT 'disponible',
      createdAt TEXT NOT NULL,
      redeemedAt TEXT,
      FOREIGN KEY (clienteId) REFERENCES clientes(id),
      FOREIGN KEY (reservaId) REFERENCES reservas(id)
    )
  `);

  await run('CREATE INDEX IF NOT EXISTS idx_reservas_slot ON reservas(fecha, hora, cancha)');
  await run('CREATE INDEX IF NOT EXISTS idx_reservas_cliente ON reservas(clienteId, estado)');
  await run('CREATE INDEX IF NOT EXISTS idx_recompensas_cliente ON recompensas(clienteId, estado)');

  const settingExists = await get('SELECT value FROM settings WHERE key = ?', ['precio_hora']);
  if (!settingExists) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?)', ['precio_hora', '100000']);
  }

  const rewardExists = await get('SELECT value FROM settings WHERE key = ?', ['reward_threshold']);
  if (!rewardExists) {
    await run('INSERT INTO settings (key, value) VALUES (?, ?)', ['reward_threshold', '10']);
  }
}

function scheduleGoogleDriveBackups() {
  if (process.env.BACKUP_DRIVE_ENABLED !== 'true') return;
  const required = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_DRIVE_FOLDER_ID', 'BACKUP_ENCRYPTION_KEY'];
  if (required.some((key) => !process.env[key])) {
    throw new Error('Google Drive backup is enabled, but required credentials are missing.');
  }
  const hour = Number(process.env.BACKUP_DAILY_UTC_HOUR || 3);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error('BACKUP_DAILY_UTC_HOUR must be an integer from 0 to 23.');
  }

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hour, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    backupTimer = setTimeout(runBackup, next.getTime() - now.getTime());
  };

  const runBackup = () => {
    backupProcess = spawn(process.execPath, [path.join(__dirname, 'scripts', 'backup-drive.js')], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    backupProcess.stdout.on('data', (chunk) => { output += chunk; });
    backupProcess.stderr.on('data', (chunk) => { output += chunk; });
    backupProcess.once('error', (error) => console.error('Scheduled backup could not start:', error.message));
    backupProcess.once('exit', (code) => {
      if (code === 0) console.log('Scheduled encrypted Google Drive backup completed.');
      else console.error('Scheduled encrypted Google Drive backup failed:', output.slice(-1000));
      backupProcess = null;
      scheduleNext();
    });
  };

  scheduleNext();
  console.log(`Encrypted Google Drive backup scheduled daily at ${String(hour).padStart(2, '0')}:00 UTC.`);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function provisionAdmin() {
  // Las variables de entorno tienen prioridad; en desarrollo local se usa el admin de .dev-admin.json (excepto en tests/producción).
  const useFixed = process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production';
  const username = String(process.env.ADMIN_USERNAME || (useFixed && FIXED_ADMIN ? FIXED_ADMIN.username : '')).trim().toLowerCase();
  const phone = normalizePhone(process.env.ADMIN_PHONE || (useFixed && FIXED_ADMIN ? FIXED_ADMIN.phone : ''));
  const password = process.env.ADMIN_PASSWORD || (useFixed && FIXED_ADMIN ? FIXED_ADMIN.password : '');
  if (!username && !phone && !password && process.env.NODE_ENV !== 'production') {
    return;
  }
  if (!/^[a-z0-9._-]{3,64}$/.test(username) || phone.length !== 10 || password.length < 12) {
    throw new Error('Set ADMIN_USERNAME (3-64 letters, digits, dot, underscore or hyphen), ADMIN_PHONE (10 digits), and ADMIN_PASSWORD (at least 12 characters).');
  }

  const existingByUsername = await get('SELECT id, role, passwordHash, sessionVersion FROM clientes WHERE username = ?', [username]);
  const existingByPhone = await get('SELECT id, role, passwordHash, sessionVersion FROM clientes WHERE phone = ?', [phone]);
  const existing = existingByUsername || existingByPhone;
  if (existing) {
    if (existing.role !== 'admin' || (existingByUsername && existingByPhone && existingByUsername.id !== existingByPhone.id)) {
      throw new Error('ADMIN_USERNAME or ADMIN_PHONE already belongs to another account. Choose unused admin credentials.');
    }
    const passwordMatches = await bcrypt.compare(password, existing.passwordHash);
    if (passwordMatches) {
      await run('UPDATE clientes SET username = ? WHERE id = ?', [username, existing.id]);
    } else {
      const passwordHash = await bcrypt.hash(password, 12);
      await run(
        'UPDATE clientes SET username = ?, passwordHash = ?, sessionVersion = sessionVersion + 1 WHERE id = ?',
        [username, passwordHash, existing.id]
      );
    }
    return;
  }

  const id = `adm_${crypto.randomUUID()}`;
  const passwordHash = await bcrypt.hash(password, 12);
  await run(
    'INSERT INTO clientes (id, name, phone, username, passwordHash, createdAt, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, 'Administrador', phone, username, passwordHash, new Date().toISOString(), 'admin']
  );
}

function fechaToISO(dateString) {
  if (!dateString) return '';
  if (dateString.includes('/')) {
    const parts = dateString.split('/');
    if (parts.length === 3) {
      const [dia, mes, anio] = parts;
      const year = anio.length === 4 ? anio : `20${anio}`;
      return `${year}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }
  }
  return dateString;
}

function parseReservationInput(body = {}) {
  const name = String(body.name || '').trim();
  const phone = normalizePhone(body.phone);
  const fecha = fechaToISO(String(body.fecha || '').trim());
  const hora = String(body.hora || '').trim();
  const cancha = String(body.cancha || '').trim();
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const parsedDate = dateMatch ? new Date(`${fecha}T00:00:00.000Z`) : null;
  const dateIsValid = parsedDate && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === fecha;

  if (name.length < 2 || name.length > 100) {
    return { error: 'El nombre debe tener entre 2 y 100 caracteres.' };
  }
  if (phone.length !== 10) {
    return { error: 'El teléfono debe tener 10 dígitos.' };
  }
  if (!dateIsValid) {
    return { error: 'La fecha debe ser válida y usar el formato AAAA-MM-DD.' };
  }
  // Colombia es UTC-5 durante todo el año; se calcula "hoy" con la hora local de la cancha.
  const todayISO = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (fecha < todayISO) {
    return { error: 'La fecha no puede ser anterior a hoy.' };
  }
  if (!/^\d{2}:\d{2} (AM|PM) - \d{2}:\d{2} (AM|PM)$/.test(hora)) {
    return { error: 'La hora no es válida.' };
  }
  if (!['Fútbol 5', 'Fútbol 8', 'Fútbol 11'].includes(cancha)) {
    return { error: 'La cancha no es válida.' };
  }
  return { value: { name, phone, fecha, hora, cancha } };
}

async function createReservation({ name, phone, fecha, hora, cancha, clienteId }) {
  return withTransaction(async () => {
    const duplicate = await get(
      'SELECT id FROM reservas WHERE phone = ? AND fecha = ? AND hora = ? AND cancha = ? AND estado != ?',
      [phone, fecha, hora, cancha, 'cancelada']
    );
    if (duplicate) {
      const error = new Error('El cliente ya tiene una reserva para ese horario.');
      error.status = 409;
      throw error;
    }

    const occupied = await get(
      'SELECT COUNT(*) AS count FROM reservas WHERE fecha = ? AND hora = ? AND cancha = ? AND estado != ?',
      [fecha, hora, cancha, 'cancelada']
    );
    if (occupied.count >= 3) {
      const error = new Error('El horario ya está completo.');
      error.status = 409;
      throw error;
    }

    const reservaId = `res_${crypto.randomUUID()}`;
    const codigo = `FNC-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    await run(
      'INSERT INTO reservas (id, clienteId, codigo, name, phone, fecha, hora, cancha, sello, origen, estado, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [reservaId, clienteId || null, codigo, name, phone, fecha, hora, cancha, 'Pendiente', 'Manual Web', 'pendiente', new Date().toISOString()]
    );
    return { reservaId, codigo };
  });
}

function createToken(user) {
  return jwt.sign({ sub: user.id, phone: user.phone, role: user.role, sv: user.sessionVersion || 1 }, JWT_SECRET, { expiresIn: '7d' });
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

function readSessionToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim() || null;
  }
  const cookies = String(req.headers.cookie || '').split(';');
  const sessionCookie = cookies.find((cookie) => cookie.trim().startsWith(`${SESSION_COOKIE}=`));
  return sessionCookie ? sessionCookie.trim().slice(SESSION_COOKIE.length + 1) : null;
}

async function authRequired(req, res, next) {
  const token = readSessionToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Token requerido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT id, name, phone, role, activo, sessionVersion FROM clientes WHERE id = ?', [decoded.sub]);
    if (!user || !user.activo || decoded.sv !== user.sessionVersion) {
      return res.status(401).json({ error: 'La cuenta ya no está disponible.' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: 'No tienes permiso para esta operación.' });
    }
    return next();
  };
}

app.use(helmet({
  contentSecurityPolicy: false,
}));
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, origin || true);
    }
    return callback(null, false);
  },
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    if (new URL(origin).origin !== requestOrigin) {
      return res.status(403).json({ error: 'Solicitud de otro origen bloqueada.' });
    }
  } catch {
    return res.status(403).json({ error: 'Origen de solicitud no válido.' });
  }
  return next();
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, intenta más tarde.' }
});
app.use('/api', apiLimiter);
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo más tarde.' }
});
app.use(['/api/clientes/register', '/api/clientes/login'], authLimiter);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'FUNCAPAZE API active', timestamp: new Date().toISOString() });
});

app.get('/api/settings', async (req, res) => {
  try {
    const precio = await get('SELECT value FROM settings WHERE key = ?', ['precio_hora']);
    const threshold = await get('SELECT value FROM settings WHERE key = ?', ['reward_threshold']);
    res.json({
      precioHora: Number(precio?.value || 100000),
      rewardThreshold: Number(threshold?.value || 10),
      currency: 'COP'
    });
  } catch (error) {
    res.status(500).json({ error: 'Error leyendo configuración.' });
  }
});

app.get('/api/disponibilidad', async (req, res) => {
  const fecha = String(req.query.fecha || '');
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T00:00:00.000Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== fecha) {
    return res.status(400).json({ error: 'Fecha no válida.' });
  }
  try {
    const rows = await all(
      'SELECT hora, cancha, COUNT(*) AS ocupadas FROM reservas WHERE fecha = ? AND estado != ? GROUP BY hora, cancha',
      [fecha, 'cancelada']
    );
    return res.json(rows);
  } catch (error) {
    console.error('Availability error:', error);
    return res.status(500).json({ error: 'No se pudo consultar la disponibilidad.' });
  }
});

app.post('/api/clientes/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body || {};
    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Nombre, teléfono y contraseña son obligatorios.' });
    }

    const cleanName = String(name).trim();
    if (cleanName.length < 2 || cleanName.length > 100) {
      return res.status(400).json({ error: 'El nombre debe tener entre 2 y 100 caracteres.' });
    }
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length !== 10) {
      return res.status(400).json({ error: 'El teléfono debe tener 10 dígitos.' });
    }
    if (String(password).length < 12 || String(password).length > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 12 y 128 caracteres.' });
    }

    const existing = await get('SELECT id FROM clientes WHERE phone = ?', [cleanPhone]);
    if (existing) {
      return res.status(409).json({ error: 'Ese teléfono ya tiene una cuenta registrada.' });
    }

    const passwordHash = await bcrypt.hash(String(password), 12);
    const id = `cli_${crypto.randomUUID()}`;

    await run(
      'INSERT INTO clientes (id, name, phone, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)',
      [id, cleanName, cleanPhone, passwordHash, new Date().toISOString()]
    );

    const user = { id, name: cleanName, phone: cleanPhone, role: 'cliente', sessionVersion: 1 };
    const token = createToken(user);
    setSessionCookie(res, token);
    res.status(201).json({ user, token });
  } catch (error) {
    console.error('Register error:', error);
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: 'Ese teléfono ya tiene una cuenta registrada.' });
    }
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/clientes/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const identifier = String(req.body?.identifier || req.body?.phone || '').trim();
    const cleanPhone = normalizePhone(identifier);
    if (!identifier || !password) {
      return res.status(400).json({ error: 'Usuario/teléfono y contraseña son obligatorios.' });
    }

    const userRow = await get('SELECT * FROM clientes WHERE (phone = ? OR username = ?) AND activo = 1', [cleanPhone, identifier.toLowerCase()]);
    if (!userRow) {
      return res.status(401).json({ error: 'Teléfono o contraseña incorrectos.' });
    }

    const valid = await bcrypt.compare(String(password), userRow.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Teléfono o contraseña incorrectos.' });
    }

    const user = { id: userRow.id, name: userRow.name, phone: userRow.phone, role: userRow.role, sessionVersion: userRow.sessionVersion };
    const token = createToken(user);
    setSessionCookie(res, token);
    res.json({ user, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Error al iniciar sesión.' });
  }
});

app.post('/api/clientes/logout', (req, res) => {
  clearSessionCookie(res);
  return res.json({ message: 'Sesión cerrada.' });
});

// Emite un token Bearer nuevo para quien ya tiene una sesión válida (cookie).
// Útil para integraciones o clientes móviles sin exponer la cookie de la web.
app.post('/api/clientes/token', authRequired, (req, res) => {
  return res.json({ token: createToken(req.user) });
});

app.get('/api/session', async (req, res) => {
  const token = readSessionToken(req);
  if (!token) return res.json({ authenticated: false });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT id, name, phone, role, activo, sessionVersion FROM clientes WHERE id = ?', [decoded.sub]);
    if (!user || !user.activo || decoded.sv !== user.sessionVersion) {
      clearSessionCookie(res);
      return res.json({ authenticated: false });
    }
    return res.json({
      authenticated: true,
      user: { id: user.id, name: user.name, phone: user.phone, role: user.role }
    });
  } catch {
    clearSessionCookie(res);
    return res.json({ authenticated: false });
  }
});

app.get('/api/clientes/me', authRequired, async (req, res) => {
  try {
    const userRow = await get('SELECT id, name, phone, role, createdAt FROM clientes WHERE id = ?', [req.user.id]);
    if (!userRow) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }

    const reservas = await all(
      'SELECT id, codigo, fecha, hora, cancha, sello, estado, createdAt FROM reservas WHERE clienteId = ? ORDER BY createdAt DESC',
      [userRow.id]
    );
    const precio = await get('SELECT value FROM settings WHERE key = ?', ['precio_hora']);
    const completed = await get('SELECT COUNT(*) AS count FROM reservas WHERE clienteId = ? AND estado = ?', [userRow.id, 'completada']);
    const availableRewards = await get('SELECT COUNT(*) AS count FROM recompensas WHERE clienteId = ? AND estado = ?', [userRow.id, 'disponible']);
    const redeemedRewards = await get('SELECT COUNT(*) AS count FROM recompensas WHERE clienteId = ? AND estado = ?', [userRow.id, 'redimida']);
    const sellosTotal = completed.count;

    res.json({
      user: {
        id: userRow.id,
        name: userRow.name,
        phone: userRow.phone,
        role: userRow.role,
        createdAt: userRow.createdAt
      },
      reservas,
      precioHora: Number(precio?.value || 100000),
      rewardThreshold: 10,
      sellosTotal,
      sellosEnCiclo: sellosTotal % 10,
      horasGratisGanadas: availableRewards.count,
      horasGratisRedimidas: redeemedRewards.count
    });
  } catch (error) {
    console.error('Get me error:', error);
    res.status(500).json({ error: 'Error consultando el perfil.' });
  }
});

app.post('/api/clientes/me/desactivar', authRequired, requireRole('cliente'), async (req, res) => {
  try {
    await run('UPDATE clientes SET activo = 0, sessionVersion = sessionVersion + 1 WHERE id = ?', [req.user.id]);
    clearSessionCookie(res);
    return res.json({ message: 'Cuenta desactivada. El historial se conserva.' });
  } catch (error) {
    console.error('Deactivate account error:', error);
    return res.status(500).json({ error: 'No se pudo desactivar la cuenta.' });
  }
});

app.post('/api/clientes/:phone/activar', authRequired, requireRole('admin'), async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (phone.length !== 10) {
    return res.status(400).json({ error: 'Teléfono no válido.' });
  }
  try {
    const result = await run('UPDATE clientes SET activo = 1, sessionVersion = sessionVersion + 1 WHERE phone = ? AND role = ?', [phone, 'cliente']);
    return result.changes
      ? res.json({ message: 'Cuenta reactivada.' })
      : res.status(404).json({ error: 'Cuenta de cliente no encontrada.' });
  } catch (error) {
    console.error('Reactivate account error:', error);
    return res.status(500).json({ error: 'No se pudo reactivar la cuenta.' });
  }
});

app.get('/api/reservas', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const rows = await all('SELECT * FROM reservas ORDER BY createdAt DESC');
    res.json(rows);
  } catch (error) {
    console.error('List reservas error:', error);
    res.status(500).json({ error: 'Error listando reservas.' });
  }
});

app.get('/api/reservas/cliente/:phone', authRequired, async (req, res) => {
  try {
    const phone = normalizePhone(req.params.phone);
    if (req.user.role !== 'admin' && phone !== req.user.phone) {
      return res.status(403).json({ error: 'Solo puedes consultar tus propias reservas.' });
    }
    if (phone.length !== 10) {
      return res.status(400).json({ error: 'Teléfono no válido.' });
    }
    const rows = req.user.role === 'admin'
      ? await all('SELECT * FROM reservas WHERE phone = ? ORDER BY createdAt DESC', [phone])
      : await all(
        'SELECT id, codigo, fecha, hora, cancha, sello, estado, createdAt FROM reservas WHERE clienteId = ? ORDER BY createdAt DESC',
        [req.user.id]
      );
    res.json(rows);
  } catch (error) {
    console.error('Reservas cliente error:', error);
    res.status(500).json({ error: 'Error consultando reservas del cliente.' });
  }
});

app.post('/api/reservas/manual', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const parsed = parseReservationInput(req.body);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }

    const reservation = await createReservation({ ...parsed.value, clienteId: null });
    res.status(201).json({ id: reservation.reservaId, message: 'Reserva creada correctamente.', codigo: reservation.codigo, estado: 'pendiente' });
  } catch (error) {
    console.error('Manual reservation error:', error);
    res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo guardar la reserva.' });
  }
});

app.post('/api/reservas', authRequired, requireRole('cliente'), async (req, res) => {
  const parsed = parseReservationInput({ ...req.body, name: req.user.name, phone: req.user.phone });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  try {
    const reservation = await createReservation({ ...parsed.value, clienteId: req.user.id });
    return res.status(201).json({ id: reservation.reservaId, message: 'Reserva creada correctamente.', codigo: reservation.codigo, estado: 'pendiente' });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.status ? error.message : 'No se pudo guardar la reserva.' });
  }
});

app.post('/api/reservas/:id/completar', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const outcome = await withTransaction(async () => {
      const reservation = await get('SELECT clienteId, estado FROM reservas WHERE id = ?', [req.params.id]);
      if (!reservation) {
        throw Object.assign(new Error('Reserva no encontrada.'), { status: 404 });
      }
      if (reservation.estado !== 'pendiente') {
        throw Object.assign(new Error('La reserva ya fue procesada.'), { status: 409 });
      }
      const result = await run(
        'UPDATE reservas SET estado = ?, sello = ? WHERE id = ? AND estado = ?',
        ['completada', 'Sello validado', req.params.id, 'pendiente']
      );
      if (!result.changes) {
        throw Object.assign(new Error('La reserva ya fue procesada.'), { status: 409 });
      }
      let rewardCreated = false;
      let cliente = null;
      if (reservation.clienteId) {
        const completed = await get(
          'SELECT COUNT(*) AS count FROM reservas WHERE clienteId = ? AND estado = ?',
          [reservation.clienteId, 'completada']
        );
        if (completed.count > 0 && completed.count % 10 === 0) {
          await run(
            'INSERT INTO recompensas (id, clienteId, reservaId, estado, createdAt) VALUES (?, ?, ?, ?, ?)',
            [`rew_${crypto.randomUUID()}`, reservation.clienteId, req.params.id, 'disponible', new Date().toISOString()]
          );
          cliente = await get('SELECT name, phone FROM clientes WHERE id = ?', [reservation.clienteId]);
          rewardCreated = true;
        }
      }
      return { rewardCreated, cliente };
    });
    // Aviso por SMS al cliente cuando gana la hora gratis (fuera de la transacción).
    let sms = null;
    if (outcome.rewardCreated && outcome.cliente) {
      const mensaje = `⚽ ¡Felicitaciones ${outcome.cliente.name}! Completaste tus 10 sellos en FUNCAPAZE y ganaste una HORA GRATIS. Valídala en ventanilla o escribe al +57 3188385367.`;
      sms = await sendSms(`+57${outcome.cliente.phone}`, mensaje);
    }
    return res.json({
      message: outcome.rewardCreated
        ? 'Reserva completada, sello acreditado y hora gratis otorgada.'
        : 'Reserva completada y sello acreditado.',
      rewardCreated: outcome.rewardCreated,
      sms
    });
  } catch (error) {
    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }
    if (error.status === 409) {
      return res.status(409).json({ error: error.message });
    }
    console.error('Complete reservation error:', error);
    return res.status(500).json({ error: 'No se pudo completar la reserva.' });
  }
});

app.get('/api/clientes/:phone/recompensas', authRequired, requireRole('admin'), async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (phone.length !== 10) {
    return res.status(400).json({ error: 'Teléfono no válido.' });
  }
  try {
    const user = await get('SELECT id FROM clientes WHERE phone = ? AND role = ?', [phone, 'cliente']);
    if (!user) {
      return res.status(404).json({ error: 'Cliente no encontrado.' });
    }
    const rewards = await all(
      'SELECT id, estado, createdAt, redeemedAt FROM recompensas WHERE clienteId = ? ORDER BY createdAt DESC',
      [user.id]
    );
    const completed = await get('SELECT COUNT(*) AS count FROM reservas WHERE clienteId = ? AND estado = ?', [user.id, 'completada']);
    return res.json({ sellosTotal: completed.count, rewards });
  } catch (error) {
    console.error('List rewards error:', error);
    return res.status(500).json({ error: 'No se pudieron consultar las recompensas.' });
  }
});

app.post('/api/recompensas/:id/redimir', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const result = await run(
      'UPDATE recompensas SET estado = ?, redeemedAt = ? WHERE id = ? AND estado = ?',
      ['redimida', new Date().toISOString(), req.params.id, 'disponible']
    );
    if (!result.changes) {
      const reward = await get('SELECT estado FROM recompensas WHERE id = ?', [req.params.id]);
      return res.status(reward ? 409 : 404).json({ error: reward ? 'La recompensa ya fue redimida.' : 'Recompensa no encontrada.' });
    }
    return res.json({ message: 'Hora gratis marcada como redimida.' });
  } catch (error) {
    console.error('Redeem reward error:', error);
    return res.status(500).json({ error: 'No se pudo redimir la recompensa.' });
  }
});

app.post('/api/reservas/:id/cancelar', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const result = await run(
      'UPDATE reservas SET estado = ?, sello = ? WHERE id = ? AND estado = ?',
      ['cancelada', 'Cancelada', req.params.id, 'pendiente']
    );
    if (!result.changes) {
      const reservation = await get('SELECT estado FROM reservas WHERE id = ?', [req.params.id]);
      return res.status(reservation ? 409 : 404).json({ error: reservation ? 'Solo se pueden cancelar reservas pendientes.' : 'Reserva no encontrada.' });
    }
    return res.json({ message: 'Reserva cancelada.' });
  } catch (error) {
    console.error('Cancel reservation error:', error);
    return res.status(500).json({ error: 'No se pudo cancelar la reserva.' });
  }
});

app.use('/assets', express.static(path.join(__dirname, 'assets'), { dotfiles: 'deny', index: false }));

function sendHtmlPage(res, fileName) {
  const nonce = crypto.randomBytes(18).toString('base64');
  const html = fs.readFileSync(path.join(__dirname, fileName), 'utf8')
    .replace(/<script\b/g, `<script nonce="${nonce}"`)
    .replace(/<style\b/g, `<style nonce="${nonce}"`);
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' https://corsproxy.io https://api.allorigins.win https://api.codetabs.com https://docs.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join('; '));
  res.set('Cache-Control', 'no-store');
  return res.type('html').send(html);
}

app.get('/qr.png', async (req, res) => {
  try {
    const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
    const customerUrl = new URL('/cliente.html#registro', baseUrl).toString();
    const image = await QRCode.toBuffer(customerUrl, {
      type: 'png',
      width: 800,
      margin: 4,
      errorCorrectionLevel: 'Q'
    });
    res.set('Cache-Control', 'public, max-age=3600');
    return res.type('png').send(image);
  } catch (error) {
    console.error('QR generation error:', error);
    return res.status(500).json({ error: 'No se pudo generar el código QR.' });
  }
});

app.get(['/cliente', '/cliente.html'], (req, res) => {
  sendHtmlPage(res, 'cliente.html');
});

app.get('/qr.html', (req, res) => sendHtmlPage(res, 'qr.html'));
app.get(['/','/index.html'], (req, res) => sendHtmlPage(res, 'index.html'));
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'sw.js')));
app.use((req, res) => {
  res.status(404).json({ error: 'No encontrado.' });
});

async function startServer() {
  await initDatabase();
  await provisionAdmin();
  scheduleGoogleDriveBackups();
  app.listen(port, () => {
    console.log(`FUNCAPAZE API running at http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Start error:', error);
  process.exit(1);
});

function closeDatabase() {
  if (backupTimer) clearTimeout(backupTimer);
  if (backupProcess) backupProcess.kill('SIGTERM');
  db.close();
  process.exit(0);
}

process.on('SIGINT', closeDatabase);
process.on('SIGTERM', closeDatabase);