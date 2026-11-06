<?php
/**
 * FUNCAPAZE — Formulario público de solicitud de reserva
 * ------------------------------------------------------
 * UN SOLO ARCHIVO. Requiere un hosting con PHP 7.4+ (Render Node NO ejecuta PHP;
 * úsalo en un hosting compartido cPanel o similar).
 *
 * Qué hace:
 *  1. Muestra un formulario (nombre, teléfono, fecha, horario, cancha) con las
 *     MISMAS reglas que valida la app Node: teléfono de 10 dígitos, fecha hoy o futura.
 *  2. Protege con token CSRF, campo honeypot anti-bots y un límite simple de 1 envío
 *     por cada 30 segundos por IP.
 *  3. Guarda cada solicitud en data_form/reservas-php.csv (protegido con .htaccess
 *     para que nadie pueda descargarlo desde el navegador).
 *  4. Al guardar, muestra un botón que abre WhatsApp con el mensaje ya escrito,
 *     como hace tu panel de administración.
 */

declare(strict_types=1);
session_start();

const ZONA_HORARIA = 'America/Bogota';
const CARPETA_DATOS = __DIR__ . '/data_form';
const ARCHIVO_CSV   = CARPETA_DATOS . '/reservas-php.csv';

date_default_timezone_set(ZONA_HORARIA);

$horarios = [
    '08:00 AM - 09:00 AM', '09:00 AM - 10:00 AM', '10:00 AM - 11:00 AM',
    '11:00 AM - 12:00 PM', '12:00 PM - 01:00 PM', '01:00 PM - 02:00 PM',
    '02:00 PM - 03:00 PM', '03:00 PM - 04:00 PM', '04:00 PM - 05:00 PM',
    '05:00 PM - 06:00 PM', '06:00 PM - 07:00 PM', '07:00 PM - 08:00 PM',
    '08:00 PM - 09:00 PM', '09:00 PM - 10:00 PM',
];
$canchas = ['Fútbol 5', 'Fútbol 8', 'Fútbol 11'];

/* ---------- Helpers ---------- */

function e(?string $valor): string {
    return htmlspecialchars((string) $valor, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function prepararAlmacenamiento(string $carpeta, string $archivo): void {
    if (!is_dir($carpeta) && !mkdir($carpeta, 0770, true)) {
        throw new RuntimeException('No se pudo crear la carpeta de datos.');
    }
    $htaccess = $carpeta . '/.htaccess';
    if (!file_exists($htaccess)) {
        file_put_contents($htaccess, "Require all denied\n");
    }
    if (!file_exists($archivo)) {
        $cabecera = ['Marca temporal', 'Nombre', 'Telefono', 'Fecha', 'Horario', 'Cancha', 'IP'];
        $manejador = fopen($archivo, 'a');
        flock($manejador, LOCK_EX);
        fputcsv($manejador, $cabecera);
        flock($manejador, LOCK_UN);
        fclose($manejador);
        chmod($archivo, 0660);
    }
}

/* ---------- Validación (espejo de las reglas de la app) ---------- */

function validar(array $datos, array $horarios, array $canchas): array {
    $errores = [];

    if ($datos['cerebro'] !== '') { // honeypot: solo los bots lo rellenan
        return [['No se pudo registrar la solicitud.'], '', '', ''];
    }

    $nombre = trim(str_replace(["\r", "\n"], ' ', $datos['nombre']));
    if (mb_strlen($nombre) < 2 || mb_strlen($nombre) > 100) {
        $errores[] = 'El nombre debe tener entre 2 y 100 caracteres.';
    }

    $telefono = preg_replace('/\D/', '', $datos['telefono']);
    if (strlen($telefono) !== 10) {
        $errores[] = 'El teléfono debe tener 10 dígitos.';
    }

    $fecha = trim($datos['fecha']);
    $dt = DateTime::createFromFormat('!Y-m-d', $fecha, new DateTimeZone(ZONA_HORARIA));
    if (!$dt || $dt->format('Y-m-d') !== $fecha) {
        $errores[] = 'La fecha no es válida.';
    } else {
        $hoy = (new DateTime('today', new DateTimeZone(ZONA_HORARIA)))->format('Y-m-d');
        if ($fecha < $hoy) {
            $errores[] = 'La fecha no puede ser anterior a hoy.';
        }
    }

    if (!in_array($datos['horario'], $horarios, true)) {
        $errores[] = 'El horario no es válido.';
    }
    if (!in_array($datos['cancha'], $canchas, true)) {
        $errores[] = 'La cancha no es válida.';
    }

    return [$errores, $nombre, $telefono, $fecha];
}

function limpiarLimitador(string $carpeta): void {
    foreach (glob($carpeta . '/rl_*') ?: [] as $file) {
        if (filemtime($file) < time() - 60) {
            @unlink($file);
        }
    }
}

/* ---------- Proceso del envío ---------- */

$errores = [];
$exito = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $tokenEnviado = (string) ($_POST['csrf'] ?? '');
    $tokenSesion  = (string) ($_SESSION['csrf'] ?? '');

    if (!$tokenSesion || !hash_equals($tokenSesion, $tokenEnviado)) {
        $errores[] = 'La sesión expiró. Recarga la página e intenta de nuevo.';
    } else {
        $_SESSION['csrf'] = bin2hex(random_bytes(16));

        [$errores, $nombre, $telefono, $fecha] = validar($_POST, $horarios, $canchas);

        if (!$errores) {
            $ip = hash('sha256', (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
            $limitador = CARPETA_DATOS . '/rl_' . substr($ip, 0, 24) . '.txt';
            prepararAlmacenamiento(CARPETA_DATOS, ARCHIVO_CSV);
            limpiarLimitador(CARPETA_DATOS);

            if (file_exists($limitador) && time() - filemtime($limitador) < 30) {
                $errores[] = 'Espera unos segundos antes de enviar otra solicitud.';
            } else {
                touch($limitador);
                $marca = (new DateTime('now', new DateTimeZone(ZONA_HORARIA)))->format('Y-m-d H:i');
                $manejador = fopen(ARCHIVO_CSV, 'a');
                flock($manejador, LOCK_EX);
                fputcsv($manejador, [$marca, $nombre, $telefono, $fecha, $_POST['horario'], $_POST['cancha'], substr($ip, 0, 16)]);
                flock($manejador, LOCK_UN);
                fclose($manejador);

                $mensaje = "¡Hola {$nombre}! Recibimos tu solicitud de reserva de *{$_POST['cancha']}* en FUNCAPAZE para el {$fecha} a las {$_POST['horario']}. El sello se acredita cuando la reserva se complete.";
                $exito = [
                    'nombre'    => $nombre,
                    'telefono'  => $telefono,
                    'fecha'     => $fecha,
                    'horario'   => $_POST['horario'],
                    'cancha'    => $_POST['cancha'],
                    'mensaje'   => $mensaje,
                    'whatsapp'  => 'https://wa.me/57' . $telefono . '?text=' . rawurlencode($mensaje),
                ];
                $_SESSION['csrf'] = bin2hex(random_bytes(16));
            }
        }
    }
}

try {
    prepararAlmacenamiento(CARPETA_DATOS, ARCHIVO_CSV);
} catch (RuntimeException $e) {
    http_response_code(500);
    exit('<h1>Error del servidor</h1><p>No se pudo preparar el almacenamiento. Revisa permisos de la carpeta.</p>');
}

$csrf = $_SESSION['csrf'] ??= bin2hex(random_bytes(16));
$hoy  = (new DateTime('today', new DateTimeZone(ZONA_HORARIA)))->format('Y-m-d');
$corteza = fn(?string $v): string => trim(str_replace(["\r", "\n"], ' ', (string) $v));
?>
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>FUNCAPAZE — Solicitar reserva</title>
    <style>
        :root {
            --bg: #030712; --card: #111827; --input: #1f2937;
            --primary: #10b981; --text: #f8fafc; --muted: #94a3b8;
            --border: #334155; --danger: #ef4444; --amber: #fbbf24;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0; min-height: 100vh; padding: 18px;
            background: linear-gradient(180deg, #030712 0%, #0b1120 100%);
            color: var(--text); font-family: 'Segoe UI', Tahoma, sans-serif;
            display: flex; justify-content: center; align-items: flex-start;
        }
        .app { max-width: 540px; width: 100%; }
        .card {
            background: rgba(17, 24, 39, .95); border: 1px solid var(--border);
            border-radius: 18px; padding: 22px; box-shadow: 0 14px 35px rgba(0, 0, 0, .25);
        }
        .marca { font-size: 22px; font-weight: 800; color: var(--primary); }
        .pill {
            background: rgba(16, 185, 129, .14); color: var(--primary);
            border: 1px solid rgba(16, 185, 129, .5); border-radius: 999px;
            padding: 4px 10px; font-size: 11px; font-weight: 800; text-transform: uppercase;
        }
        label { display: block; font-weight: 700; color: var(--muted); margin: 12px 0 6px; font-size: 12px; }
        input, select {
            width: 100%; background: var(--input); border: 1px solid var(--border);
            color: var(--text); padding: 12px 14px; border-radius: 12px; font-size: 14px;
        }
        button {
            width: 100%; border: none; border-radius: 12px; padding: 12px 18px;
            font-weight: 800; cursor: pointer; font-size: 14px; margin-top: 16px;
            background: linear-gradient(135deg, var(--primary), #14b8a6); color: #022c22;
        }
        .btn-wa {
            background: #22c55e; color: #04220f; display: block; text-align: center;
            text-decoration: none; font-weight: 800; border-radius: 12px;
            padding: 12px 18px; font-size: 14px; margin-top: 16px;
        }
        .errores { background: rgba(239, 68, 68, .1); border: 1px solid rgba(239, 68, 68, .4); color: #fca5a5; border-radius: 12px; padding: 12px; font-size: 13px; margin-top: 14px; }
        .exito { background: rgba(16, 185, 129, .1); border: 1px solid rgba(16, 185, 129, .45); border-radius: 12px; padding: 14px; margin-top: 14px; font-size: 14px; }
        .aviso { background: rgba(251, 191, 36, .08); border: 1px solid rgba(251, 191, 36, .3); color: #fcd34d; border-radius: 12px; padding: 12px; font-size: 12px; margin-top: 18px; }
        .dns { display: none; } /* honeypot */
        p { color: var(--muted); font-size: 13px; }
    </style>
</head>
<body>
    <div class="app">
        <div class="card">
            <div><span class="marca">⚽ FUNCAPAZE</span> &nbsp;<span class="pill">Reservas</span></div>
            <p>Completa el formulario y tu solicitud quedará registrada. El sello se acredita cuando la reserva se complete.</p>

            <?php if ($exito): ?>
                <div class="exito">
                    <strong>✅ ¡Solicitud registrada, <?= e($exito['nombre']) ?>!</strong>
                    <p style="margin: 8px 0 0;">
                        <?= e($exito['cancha']) ?> · <?= e($exito['fecha']) ?> · <?= e($exito['horario']) ?>
                    </p>
                    <?php if ($exito['telefono'] !== ''): ?>
                        <a class="btn-wa" href="<?= e($exito['whatsapp']) ?>" target="_blank" rel="noopener">
                            📲 Notificarme por WhatsApp
                        </a>
                    <?php endif; ?>
                </div>
            <?php else: ?>
                <?php if ($errores): ?>
                    <div class="errores">
                        <?php foreach ($errores as $error): ?>
                            <div>⚠ <?= e($error) ?></div>
                        <?php endforeach; ?>
                    </div>
                <?php endif; ?>
                <form method="post" action="">
                    <input type="hidden" name="csrf" value="<?= e($csrf) ?>">
                    <input type="text" name="cerebro" class="dns" tabindex="-1" autocomplete="off">

                    <label for="nombre">Nombre completo</label>
                    <input id="nombre" name="nombre" type="text" required maxlength="100"
                           placeholder="Ej: Carlos Gómez"
                           value="<?= e($corteza($_POST['nombre'] ?? '')) ?>">

                    <label for="telefono">Celular / WhatsApp</label>
                    <input id="telefono" name="telefono" type="tel" inputmode="numeric" required
                           placeholder="Ej: 3001234567"
                           value="<?= e(preg_replace('/\D/', '', (string) ($_POST['telefono'] ?? ''))) ?>">

                    <label for="fecha">Fecha de la reserva</label>
                    <input id="fecha" name="fecha" type="date" required min="<?= e($hoy) ?>"
                           value="<?= e($corteza($_POST['fecha'] ?? '') ?: $hoy) ?>">

                    <label for="horario">Horario</label>
                    <select id="horario" name="horario" required>
                        <?php foreach ($horarios as $horario): ?>
                            <option value="<?= e($horario) ?>" <?= ($_POST['horario'] ?? '') === $horario ? 'selected' : '' ?>>
                                <?= e($horario) ?>
                            </option>
                        <?php endforeach; ?>
                    </select>

                    <label for="cancha">Tipo de cancha</label>
                    <select id="cancha" name="cancha" required>
                        <?php foreach ($canchas as $cancha): ?>
                            <option value="<?= e($cancha) ?>" <?= ($_POST['cancha'] ?? '') === $cancha ? 'selected' : '' ?>>
                                Cancha Sintética <?= e($cancha) ?>
                            </option>
                        <?php endforeach; ?>
                    </select>

                    <button type="submit">✅ Enviar solicitud</button>
                </form>
            <?php endif; ?>

            <div class="aviso">
                Las solicitudes quedan <b>pendientes</b>: el administrador confirma el horario
                desde el sistema FUNCAPAZE. El precio por hora es $100.000 COP.
            </div>
        </div>
    </div>
</body>
</html>
