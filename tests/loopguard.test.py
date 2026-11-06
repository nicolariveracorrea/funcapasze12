from pathlib import Path

html = Path('index.html').read_text(encoding='utf-8')
cliente_html = Path('cliente.html').read_text(encoding='utf-8')

assert 'function crearFirmaReserva' in html, 'Falta la función de deduplicación'
assert 'btnInstalarLinux' in html, 'Falta la opción de instalación para Linux'
assert 'href="/qr.html"' in html, 'Falta el enlace a la página QR independiente'
assert 'assets/qr-cliente.png' not in html, 'El QR no debe aparecer dentro del panel admin'
assert 'qrPreview' not in cliente_html, 'El QR no debe aparecer dentro del portal cliente'
assert 'setInterval(() => { sincronizarBotReal(false); },' not in html, 'No debe haber lectura automática del formulario'
assert 'Crear mi perfil' in cliente_html, 'Falta el flujo de registro del cliente'
assert 'perfilSellos' in cliente_html, 'Falta el perfil de sellos del cliente'
assert 'stamp-ball' in cliente_html, 'Falta el sello tipo balón'
assert '$100.000 COP' in cliente_html, 'Falta el precio por hora del cliente'
assert "apiRequest('/api/clientes/register'" in cliente_html, 'El registro no usa la API segura'
assert "apiRequest('/api/clientes/login'" in cliente_html, 'El login no usa la API segura'
assert 'passwordHash' not in cliente_html, 'No se deben guardar hashes de contraseñas en el navegador'

print('Prueba de guardas de bucle, QR y perfil cliente: OK')
