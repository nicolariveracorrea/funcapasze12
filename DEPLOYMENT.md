# Despliegue de FUNCAPAZE

## Lo implementado aquí

El backend tiene registro e inicio de sesión, cookies de sesión `HttpOnly`, rotación/revocación de sesiones, rotación del hash admin al cambiar su variable de entorno, bloqueo de cambios desde otros orígenes, reserva y disponibilidad centralizadas, acceso administrativo por rol, cancelación/completado de reservas, sellos ligados a la cuenta, emisión y redención de recompensas, desactivación/reactivación de cuentas, límite de intentos y almacenamiento SQLite. Las páginas servidas por Node tienen CSP con nonce y bloquean scripts y atributos de estilo inline. El escáner de formularios (bot del Form de Google) tiene dos modos, elegibles con el botón “🤖 AUTO: OFF/ON” del panel: en manual lee las respuestas del formulario cuando el administrador pulsa “LEER AHORA”; en automático las lee cada 2 minutos en silencio mientras la pestaña del panel está abierta y la sesión admin activa (la preferencia queda guardada en el navegador). La lectura prueba varias rutas en cascada (corsproxy.io, allorigins, codetabs y acceso directo al CSV) para tolerar fallas de terceros o filtros de red, y la deduplicación por huella dactilar (teléfono+fecha+hora+cancha) evita crear la misma reserva dos veces. Los hosts de los proxies están autorizados en la CSP del panel; al añadir o cambiar proxies actualizarla. En modo automático no se envían datos nuevos a terceros: solo se consulta el CSV público del formulario.

Además de la cookie, la API acepta autenticación por token: `/api/clientes/register` y `/api/clientes/login` devuelven `token` (JWT, 7 días), y también hay `POST /api/clientes/token` para emitir uno nuevo con una sesión vigente. Se usa con el encabezado `Authorization: Bearer <token>`, por ejemplo en_curve, integraciones o pruebas de API. El token respeta las mismas reglas que la cookie: se revoca al cambiar `sessionVersion` (rotación de contraseña) y al desactivar la cuenta. La web sigue usando la cookie `HttpOnly`; el token es opt-in para integraciones.

Las pruebas locales cubren estos flujos y `npm audit` debe seguir reportando cero vulnerabilidades antes de publicar.

## Render

El servicio existente `funcapaze-reservas` es un Static Site. Render no permite cambiar el tipo de un servicio después de crearlo; `render.yaml` crea el servicio web separado `funcapaze-reservas-app` para no interrumpir el sitio actual.

1. Antes de subir cambios, desactiva temporalmente el auto-deploy del Static Site existente. Su publicación actual apunta a la raíz del repo; al subir el backend, una publicación estática podría exponer archivos de servidor y pruebas.
2. Sube los cambios al repositorio GitHub conectado a Render.
3. En Render, crea/sincroniza un Blueprint desde ese repositorio y aplica `render.yaml`. Esto crea el nuevo Node Web Service y conserva el Static Site existente.
4. El servicio requiere el plan `0.5c-512mb` y un disco persistente; ambos pueden generar cargos. SQLite está pensado aquí para una sola instancia; para escalar o alta disponibilidad, migra a PostgreSQL administrado.
5. En Environment del nuevo servicio, introduce `ADMIN_USERNAME` (por ejemplo, `funcapaze12.2007`), `ADMIN_PHONE` con los 10 dígitos del teléfono de contacto y `ADMIN_PASSWORD` con una contraseña única de al menos 12 caracteres. No compartas la contraseña en el chat ni la guardes en Git. En producción estas tres variables son **obligatorias**: el servidor ya no incluye credenciales predeterminadas y se detiene si faltan. Para desarrollo local, `server.js` opcionalmente lee `.dev-admin.json` (archivo ignorado por Git).
6. Render genera `JWT_SECRET` automáticamente. No lo cambies después del lanzamiento sin planear la invalidación de sesiones.
7. Configura `PUBLIC_URL` con la URL HTTPS exacta del nuevo servicio. Espera el health check `/api/health` en verde; comprueba `/`, `/cliente.html`, `/qr.html`, `/qr.png` y que `/server.js` y `/data/funcapaze.db` respondan 404.
8. Descarga el PNG desde `/qr.html` del nuevo dominio para imprimir/actualizar las tarjetas. No reutilices `assets/qr-cliente.png`, que es una imagen antigua.

No reactives el auto-deploy del Static Site ni retires su servicio hasta probar el nuevo Web Service y confirmar que las tarjetas/QR apuntan al dominio nuevo.

Si el teléfono configurado ya pertenece a una cuenta cliente, el servidor se detendrá intencionalmente. Usa otro teléfono administrador; no eleva una cuenta cliente automáticamente.

## Crear administrador local

Desde la carpeta del proyecto, ejecuta `npm run create-admin`. Ingresa el usuario, el teléfono de contacto de 10 dígitos y escribe una contraseña única de al menos 12 caracteres en el prompt oculto. Después inicia el servidor con `npm start` e ingresa a `/` usando el usuario admin.

La base de datos local no crea ni modifica automáticamente el administrador de Render. En Render configura `ADMIN_USERNAME`, `ADMIN_PHONE` y `ADMIN_PASSWORD` en Environment y reinicia el servicio; el servidor crea el admin al iniciar.

## Copias de seguridad y restauración

- Ejecuta `npm run backup` para crear una copia SQLite consistente, validar su integridad y guardarla bajo `$DATA_DIR/backups/` con permisos restrictivos. En Render, ejecuta el comando desde Shell cuando esté disponible; `DATA_DIR` debe apuntar al disco persistente.
- Copia periódicamente esos archivos a almacenamiento externo cifrado y con acceso restringido. Una copia en el mismo disco no protege ante la pérdida del servicio/disco. Configura y prueba la frecuencia y retención: **[definir responsable, frecuencia, retención y destino externo]**.
- Para restaurar, detén el servicio para que no tenga abierta la base, conserva una copia externa, y ejecuta `npm run restore -- /var/data/backups/<archivo>.sqlite --confirm-database-stopped`. El comando valida la copia, crea una copia `before-restore-*` de seguridad y verifica la base restaurada.
- Para activar la copia diaria cifrada a Google Drive, crea un proyecto de Google Cloud, habilita Drive API, crea una cuenta de servicio y comparte con ella una carpeta de Drive. En las variables secretas del Web Service configura `GOOGLE_SERVICE_ACCOUNT_JSON` (JSON de la cuenta), `GOOGLE_DRIVE_FOLDER_ID` (ID de la carpeta) y `BACKUP_ENCRYPTION_KEY` (`openssl rand -base64 32`). Mantén la clave de cifrado respaldada por separado; sin ella no se pueden restaurar las copias.
- Para probar una copia externa manual, ejecuta `npm run backup-drive` después de configurar esos secretos. Cuando la subida y restauración de prueba funcionen, cambia `BACKUP_DRIVE_ENABLED` a `true` y define `BACKUP_DAILY_UTC_HOUR` entre `0` y `23`; el servicio subirá diariamente un archivo cifrado AES-256-GCM. Tras cada subida conserva solo las últimas `BACKUP_RETENTION_COUNT` copias (por defecto 14) y elimina las más antiguas de esa carpeta.
- Descarga y restaura uno con `npm run restore-drive -- <google-drive-file-id> --confirm-database-stopped`, siempre con el servicio detenido y la misma `BACKUP_ENCRYPTION_KEY`.
- El scheduler escribe los éxitos/fallos en los logs de Render; configura alertas sobre errores y define una política de retención en Drive. No habilites la tarea hasta haber probado credenciales, permisos de carpeta y restauración con una copia de prueba.
- Practica la restauración en un entorno de prueba antes de depender de ella. No ejecutes restauración sobre producción sin confirmar el archivo y la ventana de mantenimiento.

## SMS de recompensas (hora gratis)

Cuando el administrador completa la reserva con la que un cliente alcanza 10 sellos, el servidor otorga la hora gratis e intenta enviar un SMS de felicitación al celular del cliente (uso la cuenta de Twilio). Se configura con variables secretas del Web Service:

- `TWILIO_ACCOUNT_SID` — SID de la cuenta de Twilio (comienza con `AC`).
- `TWILIO_AUTH_TOKEN` — el token de autenticación de la cuenta.
- `TWILIO_FROM` — el número remitente (con código de país, p. ej. `+1…`) o sender ID válido para Colombia.

Si faltan esas variables, el sistema **no se rompe**: el aviso solo queda registrado en los logs con el prefijo `[SMS]` y la hora gratis se otorga igualmente. El envío real tiene costo por mensaje; gestiona la contratación, los costos, la verificación del número y el cumplimiento legal (opt-out) por fuera de la app. Si un proveedor falla, el endpoint de completar responde normal e incluye `sms.enviado = false` con el motivo.

## Antes de invitar clientes

- Exportar y revisar las reservas históricas guardadas en los navegadores. No se migran solas al servidor; importar solo los registros verificados y evitar duplicados.
- Completar y revisar [el borrador de privacidad y condiciones de reserva](docs/PRIVACIDAD_Y_RESERVAS.md) antes de publicarlo; define contacto legal, conservación de datos, anticipos, cancelaciones, reembolsos, clima y reglas de la hora gratis.
- Añadir verificación de propiedad del teléfono por un código de un solo uso (SMS/WhatsApp) antes de aceptar una cuenta como titular del número. El envío del código requiere configurar un proveedor externo.
- Mantener pruebas de sesión `HttpOnly`, `Secure`, `SameSite=Lax`, revocación y CSRF al cambiar el frontend o el dominio.
- La CSP protege scripts y bloques de estilo con nonces, bloquea atributos de estilo inline y solo permite conexiones al sitio y a los hosts usados por el escáner (manual o automático). Mantener la revisión de HTML dinámico al añadir funciones.
- Seguir escapando/insertando como texto todo dato variable y revisar cada nuevo uso de `innerHTML` antes de publicarlo.
- Completar una reserva desde el panel solo después de comprobar el pago/uso. El sistema no integra pagos ni confirma asistencia automáticamente.
- Desplegar y comprobar el flujo con el dominio Render final. Regenerar el QR con ese dominio y probarlo en Android, iPhone y escritorio.
- Configurar copias fuera del disco, programar alertas, dominio propio y revisar el plan de respuesta a incidentes.
- Ejecutar `npm audit` y revisar cualquier aviso antes de cada publicación.

El proyecto aún no está publicado en Render desde esta sesión. El lanzamiento comercial debe esperar a la configuración del nuevo servicio, la verificación telefónica, la revisión de estilos inline, la prueba del dominio y las políticas de datos.
