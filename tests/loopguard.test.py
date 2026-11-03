from pathlib import Path

html = Path('index.html').read_text(encoding='utf-8')
cliente_html = Path('cliente.html').read_text(encoding='utf-8')

assert 'function crearFirmaReserva' in html, 'Falta la función de deduplicación'
assert 'btnInstalarLinux' in html, 'Falta la opción de instalación para Linux'
assert 'assets/qr-cliente.png' in html, 'Falta la imagen QR estática del cliente'
assert 'setInterval(() => { sincronizarBotReal(false); },' not in html, 'No debe haber lectura automática del formulario'
assert 'Crear mi perfil' in cliente_html, 'Falta el flujo de registro del cliente'
assert 'perfilSellos' in cliente_html, 'Falta el perfil de sellos del cliente'
assert 'stamp-ball' in cliente_html, 'Falta el sello tipo balón'
assert '$100.000 COP' in cliente_html, 'Falta el precio por hora del cliente'
assert 'passwordHash' in cliente_html, 'Falta protección básica de contraseñas'

print('Prueba de guardas de bucle, QR y perfil cliente: OK')
