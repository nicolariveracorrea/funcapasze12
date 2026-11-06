// Envío de SMS (Twilio) para avisos al cliente, p. ej. al ganar una hora gratis.
// Si no están definidas las variables de entorno, el mensaje solo queda en los logs
// y la app sigue funcionando sin interrupciones.
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';

function isConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM);
}

async function sendSms(to, message) {
  const phone = String(to || '').trim();
  if (!isConfigured()) {
    console.log(`[SMS] no configurado (definir TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_FROM). Mensaje para ${phone}: ${message}`);
    return { enviado: false, motivo: 'sms_no_configurado' };
  }
  try {
    const params = new URLSearchParams({ To: phone, From: TWILIO_FROM, Body: message });
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      },
      body: params,
      signal: AbortSignal.timeout(8000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[SMS] proveedor respondió ${response.status}: ${result.message || 'sin detalle'}`);
      return { enviado: false, motivo: 'error_proveedor', detalle: result.message };
    }
    console.log(`[SMS] enviado a ${phone}. SID: ${result.sid}`);
    return { enviado: true, sid: result.sid };
  } catch (error) {
    console.error('[SMS] error de red:', error.message);
    return { enviado: false, motivo: 'error_red' };
  }
}

module.exports = { isConfigured, sendSms };
