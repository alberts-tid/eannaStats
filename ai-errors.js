// Clasifica los fallos de Firebase AI Logic. Un 503 «Deadline expired» no es saturación
// ni un problema de saldo: Google corta la petición si el modelo no termina a tiempo.

export const BUSY_INTERVAL_S = 6;

export const BUSY_NOTES = [
  'Enviando la foto a Gemini.',
  'Gemini está leyendo los dorsales y el marcador.',
  'Sigue en curso. El servidor está trabajando en la foto.',
  'La petición sigue activa. No hace falta recargar la página.',
];

export function busyNote(elapsedSeconds) {
  const step = Math.floor(Math.max(0, elapsedSeconds) / BUSY_INTERVAL_S);
  return BUSY_NOTES[step % BUSY_NOTES.length];
}

function errorText(err) {
  return `${err?.message || err || ''} ${err?.code || ''} ${err?.status || ''}`;
}

export function isDeadline(err) {
  return /deadline expired|timeout has expired/i.test(errorText(err));
}

export function isTransient(err) {
  return isDeadline(err) || /\[(500|503|429)\b|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(errorText(err));
}

export function retryMessage(err, attempt, total) {
  const why = isDeadline(err) ? 'no terminó a tiempo' : 'está saturado';
  return `Gemini ${why}. Reintentando (${attempt}/${total})…`;
}

export function describeAiError(err, model = 'gemini-3.7-flash') {
  const msg = String(err?.message || err);
  const code = String(err?.code || err?.status || '');
  const detail = ` (Detalle: ${msg}${code ? ` [${code}]` : ''})`;
  if (/api-not-enabled/.test(code) || /SERVICE_DISABLED|has not been used/i.test(msg)) {
    return `Firebase AI Logic no está activado en el proyecto. Actívalo en Firebase Console → AI Logic → Get started (Gemini Developer API).${detail}`;
  }
  if (/App Check|appCheck|app-check/i.test(msg + code)) {
    return `App Check ha rechazado la petición. En localhost registra el token de depuración que aparece en la consola del navegador (F12) en Firebase Console → App Check → Administrar tokens de depuración.${detail}`;
  }
  if (/not found|404/i.test(msg)) return `El modelo «${model}» no está disponible. Prueba otro en «Opciones».${detail}`;
  if (/prepayment credits are depleted/i.test(msg)) return `El saldo de prepago de Gemini está agotado. Recárgalo en AI Studio, proyecto eannastats, y vuelve a intentarlo.${detail}`;
  if (isDeadline(err)) {
    return `Gemini no terminó a tiempo. Google corta la petición con un 503 «Deadline expired» cuando el modelo no acaba dentro de su plazo. Con la API de pago también pasa: no es un fallo de saldo. Esta versión pide menos razonamiento y manda una foto más pequeña para caber en ese plazo. Vuelve a intentarlo.${detail}`;
  }
  if (/high demand|overloaded|UNAVAILABLE|\[50[03]\b/i.test(msg)) {
    return `Gemini está saturado ahora mismo. Espera un minuto y vuelve a intentarlo.${detail}`;
  }
  if (/rate-limited|quota|429|RESOURCE_EXHAUSTED/i.test(msg + code)) {
    return `Se ha superado la cuota de Gemini. Si el detalle habla de prepago, recarga el saldo en AI Studio.${detail}`;
  }
  if (/JSON/i.test(msg)) return `La IA ha devuelto una respuesta que no es JSON válido. Vuelve a intentarlo.${detail}`;
  return `Error al analizar: ${msg}`;
}
