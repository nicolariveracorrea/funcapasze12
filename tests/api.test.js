const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function getAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, process, getOutput) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`API process exited early: ${getOutput()}`);
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(`API did not start: ${getOutput()}`);
}

test('API protects accounts, reservations, rewards, and server files', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'funcapaze-api-'));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATA_DIR: dataDir,
      JWT_SECRET: 'test-secret-with-more-than-thirty-two-characters',
      ADMIN_USERNAME: 'testadmin',
      ADMIN_PHONE: '3000000001',
      ADMIN_PASSWORD: 'SecureAdminPassword2026!'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl, child, () => output);
  const anonymousSession = await fetch(`${baseUrl}/api/session`);
  assert.equal(anonymousSession.status, 200);
  assert.deepEqual(await anonymousSession.json(), { authenticated: false });

  const qrPage = await fetch(`${baseUrl}/qr.html`);
  assert.equal(qrPage.status, 200);
  assert.match(qrPage.headers.get('content-type'), /text\/html/);
  const qrHtml = await qrPage.text();
  const qrCsp = qrPage.headers.get('content-security-policy');
  const qrNonce = qrHtml.match(/<script nonce="([^"]+)"/);
  const styleNonce = qrHtml.match(/<style nonce="([^"]+)"/);
  assert.ok(qrNonce);
  assert.ok(styleNonce);
  assert.ok(qrCsp.includes(`'nonce-${qrNonce[1]}'`));
  assert.ok(qrCsp.includes(`'nonce-${styleNonce[1]}'`));
  assert.match(qrCsp, /style-src-attr 'none'/);
  assert.doesNotMatch(qrHtml, /\sstyle=/i);
  assert.doesNotMatch(qrHtml, /\s+on(?:click|change|keyup)=/i);
  const adminPage = await fetch(`${baseUrl}/`);
  const adminHtml = await adminPage.text();
  assert.ok(adminPage.headers.get('content-security-policy').includes("object-src 'none'"));
  assert.doesNotMatch(adminHtml, /\sstyle=/i);
  assert.doesNotMatch(adminHtml, /\s+on(?:click|change|keyup)=/i);
  const customerPage = await fetch(`${baseUrl}/cliente.html`);
  assert.ok(customerPage.headers.get('content-security-policy').includes('script-src'));
  const customerHtml = await customerPage.text();
  assert.doesNotMatch(customerHtml, /\sstyle=/i);
  assert.doesNotMatch(customerHtml, /\s+on(?:click|change|keyup)=/i);
  const qrImage = await fetch(`${baseUrl}/qr.png`);
  assert.equal(qrImage.status, 200);
  assert.match(qrImage.headers.get('content-type'), /image\/png/);
  const qrBytes = Buffer.from(await qrImage.arrayBuffer());
  assert.deepEqual([...qrBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const request = async (route, options = {}) => {
    const response = await fetch(`${baseUrl}${route}`, options);
    let body = null;
    try {
      body = await response.json();
    } catch {}
    return { response, body };
  };

  const sessionCookie = (response) => {
    const cookie = response.headers.get('set-cookie');
    assert.ok(cookie);
    return cookie.split(';', 1)[0];
  };

  const noToken = await request('/api/reservas');
  assert.equal(noToken.response.status, 401);
  const noTokenBooking = await request('/api/reservas/manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cliente', phone: '3000000002', fecha: '2026-12-01', hora: '08:00 AM - 09:00 AM', cancha: 'Fútbol 5' })
  });
  assert.equal(noTokenBooking.response.status, 401);
  const crossOriginMutation = await request('/api/clientes/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ identifier: 'testadmin', password: 'anything' })
  });
  assert.equal(crossOriginMutation.response.status, 403);

  const registration = await request('/api/clientes/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Cliente Prueba', phone: '3000000002', password: 'SecureClientPassword2026!' })
  });
  assert.equal(registration.response.status, 201);
  const clientCookie = registration.response.headers.get('set-cookie');
  assert.match(clientCookie, /HttpOnly/i);
  assert.match(clientCookie, /Secure/i);
  assert.match(clientCookie, /SameSite=Lax/i);
  assert.match(registration.body.token, /\./);
  const clientHeaders = { Cookie: sessionCookie(registration.response), 'Content-Type': 'application/json' };
  const bearerHeaders = { Authorization: `Bearer ${registration.body.token}`, 'Content-Type': 'application/json' };
  const bearerProfile = await request('/api/clientes/me', { headers: bearerHeaders });
  assert.equal(bearerProfile.response.status, 200);
  assert.equal(bearerProfile.body.user.phone, '3000000002');
  const clientSession = await request('/api/session', { headers: clientHeaders });
  assert.equal(clientSession.body.authenticated, true);
  assert.equal(clientSession.body.user.role, 'cliente');

  const forbiddenList = await request('/api/reservas', { headers: clientHeaders });
  assert.equal(forbiddenList.response.status, 403);

  const invalidDate = await request('/api/reservas', {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ fecha: '2026-99-99', hora: '08:00 AM - 09:00 AM', cancha: 'Fútbol 5' })
  });
  assert.equal(invalidDate.response.status, 400);

  const pastDate = await request('/api/reservas', {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ fecha: '2025-01-01', hora: '08:00 AM - 09:00 AM', cancha: 'Fútbol 5' })
  });
  assert.equal(pastDate.response.status, 400);

  const fecha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const booking = await request('/api/reservas', {
    method: 'POST',
    headers: clientHeaders,
    body: JSON.stringify({ name: 'Nombre no confiable', phone: '3009999999', fecha, hora: '08:00 AM - 09:00 AM', cancha: 'Fútbol 5' })
  });
  assert.equal(booking.response.status, 201);

  const profileBefore = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(profileBefore.response.status, 200, JSON.stringify(profileBefore.body));
  assert.equal(profileBefore.body.user.name, 'Cliente Prueba');
  assert.equal(profileBefore.body.reservas.length, 1);
  assert.equal(profileBefore.body.sellosTotal, 0);
  assert.equal(profileBefore.body.reservas[0].estado, 'pendiente');

  const adminLogin = await request('/api/clientes/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'testadmin', password: 'SecureAdminPassword2026!' })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = adminLogin.response.headers.get('set-cookie');
  assert.match(adminCookie, /HttpOnly/i);
  assert.match(adminCookie, /Secure/i);
  const adminHeaders = { Cookie: sessionCookie(adminLogin.response), 'Content-Type': 'application/json' };

  const manualBooking = await request('/api/reservas/manual', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'Cliente Prueba', phone: '3000000002', fecha, hora: '09:00 AM - 10:00 AM', cancha: 'Fútbol 5' })
  });
  assert.equal(manualBooking.response.status, 201);

  const availability = await request(`/api/disponibilidad?fecha=${fecha}`);
  assert.equal(availability.response.status, 200);
  assert.ok(availability.body.every((slot) => Object.keys(slot).sort().join(',') === 'cancha,hora,ocupadas'));

  const ownPhoneHistory = await request('/api/reservas/cliente/3000000002', { headers: clientHeaders });
  assert.equal(ownPhoneHistory.response.status, 200);
  assert.equal(ownPhoneHistory.body.length, 1);
  const profileWithManualReservation = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(profileWithManualReservation.body.reservas.length, 1);

  const adminList = await request('/api/reservas', { headers: adminHeaders });
  assert.equal(adminList.response.status, 200);
  assert.equal(adminList.body.length, 2);
  const manualReservation = adminList.body.find((reservation) => reservation.codigo === manualBooking.body.codigo);
  assert.ok(manualReservation);

  const manualCompleted = await request(`/api/reservas/${manualReservation.id}/completar`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(manualCompleted.response.status, 200);

  const cancellableBooking = await request('/api/reservas/manual', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ name: 'Otro Cliente', phone: '3000000003', fecha, hora: '10:00 AM - 11:00 AM', cancha: 'Fútbol 8' })
  });
  assert.equal(cancellableBooking.response.status, 201);
  const cancelled = await request(`/api/reservas/${cancellableBooking.body.id}/cancelar`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(cancelled.response.status, 200);
  const availabilityAfterCancel = await request(`/api/disponibilidad?fecha=${fecha}`);
  assert.ok(!availabilityAfterCancel.body.some((slot) => slot.cancha === 'Fútbol 8' && slot.hora === '10:00 AM - 11:00 AM'));

  const completeForbidden = await request(`/api/reservas/${booking.body.id}/completar`, {
    method: 'POST',
    headers: clientHeaders
  });
  assert.equal(completeForbidden.response.status, 403);
  const cancelForbidden = await request(`/api/reservas/${booking.body.id}/cancelar`, {
    method: 'POST',
    headers: clientHeaders
  });
  assert.equal(cancelForbidden.response.status, 403);

  const completed = await request(`/api/reservas/${booking.body.id}/completar`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.rewardCreated, false);

  const remainingSlots = [
    '10:00 AM - 11:00 AM', '11:00 AM - 12:00 PM', '12:00 PM - 01:00 PM',
    '01:00 PM - 02:00 PM', '02:00 PM - 03:00 PM', '03:00 PM - 04:00 PM',
    '04:00 PM - 05:00 PM', '05:00 PM - 06:00 PM', '06:00 PM - 07:00 PM'
  ];
  let finalCompletion;
  for (const hora of remainingSlots) {
    const nextBooking = await request('/api/reservas', {
      method: 'POST',
      headers: clientHeaders,
      body: JSON.stringify({ fecha, hora, cancha: 'Fútbol 5' })
    });
    assert.equal(nextBooking.response.status, 201);
    finalCompletion = await request(`/api/reservas/${nextBooking.body.id}/completar`, {
      method: 'POST',
      headers: adminHeaders
    });
    assert.equal(finalCompletion.response.status, 200);
  }
  assert.equal(finalCompletion.body.rewardCreated, true);

  const profileAfter = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(profileAfter.body.sellosTotal, 10);
  assert.equal(profileAfter.body.reservas.length, 10);
  assert.equal(profileAfter.body.horasGratisGanadas, 1);

  const rewards = await request('/api/clientes/3000000002/recompensas', { headers: adminHeaders });
  assert.equal(rewards.response.status, 200);
  assert.equal(rewards.body.sellosTotal, 10);
  assert.equal(rewards.body.rewards.length, 1);
  const rewardId = rewards.body.rewards[0].id;
  const redeemed = await request(`/api/recompensas/${rewardId}/redimir`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(redeemed.response.status, 200);
  const duplicateRedemption = await request(`/api/recompensas/${rewardId}/redimir`, {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(duplicateRedemption.response.status, 409);

  const profileAfterRedemption = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(profileAfterRedemption.body.horasGratisGanadas, 0);
  assert.equal(profileAfterRedemption.body.horasGratisRedimidas, 1);

  const deactivated = await request('/api/clientes/me/desactivar', {
    method: 'POST',
    headers: clientHeaders
  });
  assert.equal(deactivated.response.status, 200);
  const inactiveSessionStatus = await request('/api/session', { headers: clientHeaders });
  assert.deepEqual(inactiveSessionStatus.body, { authenticated: false });
  const inactiveProfile = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(inactiveProfile.response.status, 401);
  const inactiveBearer = await request('/api/clientes/me', { headers: bearerHeaders });
  assert.equal(inactiveBearer.response.status, 401);
  const inactiveLogin = await request('/api/clientes/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '3000000002', password: 'SecureClientPassword2026!' })
  });
  assert.equal(inactiveLogin.response.status, 401);

  const reactivated = await request('/api/clientes/3000000002/activar', {
    method: 'POST',
    headers: adminHeaders
  });
  assert.equal(reactivated.response.status, 200);
  const staleSessionAfterReactivation = await request('/api/clientes/me', { headers: clientHeaders });
  assert.equal(staleSessionAfterReactivation.response.status, 401);
  const retainedHistory = await request('/api/reservas/cliente/3000000002', { headers: adminHeaders });
  assert.equal(retainedHistory.body.length, 11);
  const activeLogin = await request('/api/clientes/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '3000000002', password: 'SecureClientPassword2026!' })
  });
  assert.equal(activeLogin.response.status, 200);
  const restoredProfile = await request('/api/clientes/me', {
    headers: { Cookie: sessionCookie(activeLogin.response) }
  });
  assert.equal(restoredProfile.body.reservas.length, 10);

  const privateSource = await request('/server.js');
  assert.equal(privateSource.response.status, 404);
  const privateDatabase = await request('/data/funcapaze.db');
  assert.equal(privateDatabase.response.status, 404);
});

test('admin password rotation on startup revokes existing sessions', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'funcapaze-admin-rotation-'));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;
  let output = '';

  const start = (password) => {
    const childProcess = spawn(global.process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...global.process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        DATA_DIR: dataDir,
        JWT_SECRET: 'rotation-test-secret-with-more-than-thirty-two-characters',
        ADMIN_USERNAME: 'rotationadmin',
        ADMIN_PHONE: '3000000004',
        ADMIN_PASSWORD: password
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    childProcess.stdout.on('data', (chunk) => { output += chunk; });
    childProcess.stderr.on('data', (chunk) => { output += chunk; });
    return childProcess;
  };

  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  child = start('OriginalAdminPassword2026!');
  await waitForHealth(baseUrl, child, () => output);
  const originalLogin = await fetch(`${baseUrl}/api/clientes/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'rotationadmin', password: 'OriginalAdminPassword2026!' })
  });
  assert.equal(originalLogin.status, 200);
  const originalCookie = originalLogin.headers.get('set-cookie').split(';', 1)[0];

  child.kill('SIGTERM');
  await once(child, 'exit');
  child = start('RotatedAdminPassword2026!');
  await waitForHealth(baseUrl, child, () => output);

  const staleSession = await fetch(`${baseUrl}/api/clientes/me`, { headers: { Cookie: originalCookie } });
  assert.equal(staleSession.status, 401);
  const oldPasswordLogin = await fetch(`${baseUrl}/api/clientes/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'rotationadmin', password: 'OriginalAdminPassword2026!' })
  });
  assert.equal(oldPasswordLogin.status, 401);
  const rotatedLogin = await fetch(`${baseUrl}/api/clientes/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'rotationadmin', password: 'RotatedAdminPassword2026!' })
  });
  assert.equal(rotatedLogin.status, 200);
});
