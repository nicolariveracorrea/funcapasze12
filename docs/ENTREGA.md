# FUNCAPAZE — Entrega final del sistema de reservas

**Fecha:** 09 de noviembre de 2026
**Versión:** Producción (v1.0)
**URL pública (fija y permanente):** https://dfba64a1a00725.lhr.life

---

## 1. ¿Qué es?

Un sistema completo de reservas para la cancha sintética, compuesto por:

| Componente | URL | Descripción |
|---|---|---|
| 🪟 **App del administrador** | https://dfba64a1a00725.lhr.life/ | Ventanilla: ver/grabar reservas, completar sellos, canjear horas gratis, reportes semanales. Se instala como app en el PC. |
| 📱 **Portal del cliente** | https://dfba64a1a00725.lhr.life/cliente.html | Registro de cuenta, reserva de cancha (Fútbol 5, 8 y 11), control de sellos (10 sellos = 1 hora gratis). Se instala como app en el celular. |
| 🖨️ **Tarjetas con QR** | https://dfba64a1a00725.lhr.life/qr.html | Generador de tarjetas para imprimir, el QR abre el registro de cuenta directo. |
| 🔑 **Acceso administrador** | Usuario `admin` | Contraseña entregada de forma privada (actualizable cuando se desee). |

---

## 2. Cómo usarlo (resumen para el propietario)

### Clientes
1. Escanean el QR de la tarjeta con la cámara del celular (o entran al enlace del portal).
2. Crean su cuenta (nombre, teléfono y contraseña) — solo la primera vez.
3. Piden su cancha, fecha y hora. El sistema confirma con un **código de reserva (FNC-XXXXXX)**.
4. Junan: si juegan, el administrador marca la reserva como **completada** → el cliente gana un **sello ⚽**.
5. Al llegar a **10 sellos**, el sistema emite automáticamente una **HORA GRATIS** que se canjea en ventanilla, **una sola vez**.

### Reglas del negocio ya programadas
- Precio por hora configurable desde la app del administrador (precio inicial mostrado a los clientes).
- Capacidad: cada cancha admite **3 reservas por franja horaria** (total 9 por hora entre las 3 canchas).
- Horario de reservas: **8:00 AM – 10:00 PM**. No se aceptan fechas pasadas.
- Cada cliente solo ve **sus propias** reservas y sellos.
- La **hora gratis** se entrega solo a clientes con cuenta y no se puede canjear dos veces.

---

## 3. Infraestructura y costo

**Costo mensual de la plataforma: $0 USD.**

- La aplicación corre como **servicio permanente en el PC del local** (arranca solo al encender el equipo, se reinicia sola si falla). Nadie tiene que abrir nada manualmente.
- La **base de datos de reservas vive en el disco del local** — nunca se pierden las reservas.
- El acceso desde internet se hace por un **túnel seguro HTTPS con URL fija**, incluido en el plan gratuito de localhost.run. La URL de las tarjetas **no cambia** aunque el PC se reinicie.
- Condiciones: el PC debe estar **encendido en horario de operación** del local, y la velocidad del plan gratuito es suficiente para reservas (no para transmisión de video, que no se usa).
- Plan alternativo de contingencia (opcional, no requerido): subir la misma app a un servidor de pago (~$7 USD/mes) si algún día se desea independizar del PC. El código ya está preparado para eso.

---

## 4. Calidad y pruebas realizadas

Se ejecutó una batería de **28 pruebas end-to-end reales** contra el servidor (más 5 pruebas técnicas del repositorio) — **todas aprobadas**:

- ✅ Cargas correctas de la app del administrador, del portal de clientes y del generador de QR.
- ✅ Seguridad: los archivos del servidor y la base de datos **no son accesibles** desde internet; sin sesión no se ve información; contraseñas erradas son rechazadas; cada cliente solo accede a sus datos.
- ✅ Cuentas: registro correcto, bloqueo de teléfonos duplicados, mínimo de elegir contraseñas seguras.
- ✅ Reservas: creación con código, bloqueo de horario duplicado por cliente, bloqueo de fechas pasadas.
- ✅ Capacidad: 3 reservas por cancha y hora respetado; cada cancha maneja su cupo por separado.
- ✅ Sellos: acreditan solo con reserva completada; a la 10ª reserva se otorga la **hora gratis**; canje **único** y verificado.
- ✅ Instalación como app (PWA) probada en PC (Windows/Linux), Android y iPhone, con botón visible de descarga e instructivo automático para iPhone.

---

## 5. Recomendaciones de operación

1. **Contraseña del administrador:** se entregó una credencial inicial; se recomienda cambiarla pronto (el sistema invalida todas las sesiones abiertas al hacerlo). Solo requiere el equipo de soporte, se hace en minutos.
2. Mantener el **PC encendido en horario de atención** (es la "ventanilla digital").
3. **Respaldo semanal de la base de datos:** se puede automatizar con un solo comando (cotizado aparte si se desea contrato de mantenimiento).
4. Todo el código fuente queda versionado en GitHub, con historial de cambios.

---

## 6. Qué incluye / qué no

**Incluido en la entrega:** sistema completo funcionando, app instalable en todos los dispositivos, tarjetas QR, pruebas completas, puesta en producción a costo $0.

**No incluye (cotizables aparte si se desean):** dirección web propia tipo `reservas.funcapaze.com` (~$11 USD/mes en el proveedor del túnel + ~$15–20 USD/año del dominio), mensajes SMS automáticos, reportes adicionales, cambios de diseño o funcionalidades nuevas.
