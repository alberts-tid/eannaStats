// Clasifica los fallos de Firebase AI Logic. Un 503 «Deadline expired» no es saturación
// ni un problema de saldo: Google corta la petición si el modelo no termina a tiempo.

export const BUSY_INTERVAL_S = 6;

export const BUSY_NOTES = [
  'Sending the photo to Gemini.',
  'Gemini is reading the jerseys and the running score.',
  'Still working. The server is processing the photo.',
  'The request is still active. You do not need to reload the page.',
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
  const why = isDeadline(err) ? 'did not finish in time' : 'is overloaded';
  return `Gemini ${why}. Retrying (${attempt}/${total})…`;
}

export function describeAiError(err, model = 'gemini-3.7-flash') {
  const msg = String(err?.message || err);
  const code = String(err?.code || err?.status || '');
  const detail = ` (Detail: ${msg}${code ? ` [${code}]` : ''})`;
  if (/api-not-enabled/.test(code) || /SERVICE_DISABLED|has not been used/i.test(msg)) {
    return `Firebase AI Logic is not enabled for this project. Turn it on in Firebase Console → AI Logic → Get started (Gemini Developer API).${detail}`;
  }
  if (/App Check|appCheck|app-check/i.test(msg + code)) {
    return `App Check rejected the request. On localhost, register the debug token printed in the browser console (F12) under Firebase Console → App Check → Manage debug tokens.${detail}`;
  }
  if (/not found|404/i.test(msg)) return `The model “${model}” is not available. Try another one under “Options”.${detail}`;
  if (/prepayment credits are depleted/i.test(msg)) return `The Gemini prepaid balance is used up. Top it up in AI Studio, project eannastats, and try again.${detail}`;
  if (isDeadline(err)) {
    return `Gemini did not finish in time. Google cuts the request with a 503 “Deadline expired” when the model does not finish within its limit. This also happens on the paid API: it is not a billing failure. This version asks for less reasoning and sends a smaller photo so it can fit that limit. Try again.${detail}`;
  }
  if (/high demand|overloaded|UNAVAILABLE|\[50[03]\b/i.test(msg)) {
    return `Gemini is overloaded right now. Wait a minute and try again.${detail}`;
  }
  if (/rate-limited|quota|429|RESOURCE_EXHAUSTED/i.test(msg + code)) {
    return `The Gemini quota has been exceeded. If the detail mentions prepayment, top up the balance in AI Studio.${detail}`;
  }
  if (/JSON/i.test(msg)) return `The AI returned a response that is not valid JSON. Try again.${detail}`;
  return `Could not analyze the scoresheet: ${msg}`;
}
