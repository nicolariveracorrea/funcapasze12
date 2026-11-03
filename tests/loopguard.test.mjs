import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const htmlPath = path.resolve('index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

if (!scriptMatch) {
  throw new Error('No se encontró el bloque <script> en index.html');
}

const script = scriptMatch[1];

const storage = new Map();
const doc = {
  getElementById(id) {
    const obj = {
      value: '',
      style: { display: '', background: '' },
      innerHTML: '',
      className: '',
      addEventListener() {},
      appendChild() {},
      querySelector() { return { innerHTML: '', appendChild() {} }; },
      children: [],
      dataset: {},
    };
    if (id === 'bookingDate') obj.value = '2026-11-04';
    if (id === 'courtType') obj.value = 'Fútbol 5';
    if (id === 'btnBot') obj.innerHTML = '⚡ LEER AHORA';
    return obj;
  },
  createElement() {
    return {
      style: {},
      className: '',
      innerHTML: '',
      appendChild() {},
      setAttribute() {},
      click() {},
      href: '',
      download: '',
    };
  },
  querySelector() {
    return { innerHTML: '', appendChild() {} };
  },
};

const win = {
  addEventListener() {},
  navigator: { standalone: false, userAgent: 'Linux x86_64' },
  matchMedia() { return { matches: false }; },
  open() {},
  setInterval() { return 1; },
  clearInterval() {},
};

const context = {
  console,
  document: doc,
  window: win,
  localStorage: {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  URL,
  Blob,
  Date,
  Math,
  setInterval: win.setInterval,
  clearInterval: win.clearInterval,
};

try {
  const vm = await import('node:vm');
  vm.runInNewContext(script, context, { filename: 'index.html' });
} catch (error) {
  console.error('Script evaluation error:', error);
  process.exitCode = 1;
}

assert.equal(typeof crearFirmaReserva, 'function', 'La función de deduplicación no existe aún');
assert.equal(crearFirmaReserva({ tel: '3001234567', fecha: '2026-11-04', hora: '08:00 AM - 09:00 AM', cancha: 'Fútbol 5' }), '3001234567_2026-11-04_08:00-am---09:00-am_fútbol-5');

console.log('Prueba de deduplicación: OK');
