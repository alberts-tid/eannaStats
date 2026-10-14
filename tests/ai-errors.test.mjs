import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { busyNote, BUSY_NOTES, describeAiError, isDeadline, isTransient, retryMessage } from '../ai-errors.js';

const DEADLINE = 'AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/eannastats/models/gemini-3.7-flash:generateContent: [503 ] Deadline expired before operation could complete. (AI/fetch-error) [fetch-error]';

test('un 503 por plazo no se presenta como saturación', () => {
  assert.equal(isDeadline(new Error(DEADLINE)), true);
  assert.equal(isTransient(new Error(DEADLINE)), true);
  const text = describeAiError(new Error(DEADLINE));
  assert.match(text, /did not finish in time/);
  assert.match(text, /not a billing failure/);
  assert.doesNotMatch(text, /overloaded/);
  assert.match(retryMessage(new Error(DEADLINE), 1, 2), /did not finish in time\. Retrying \(1\/2\)/);
  assert.doesNotMatch(retryMessage(new Error(DEADLINE), 1, 2), /overloaded/);
});

test('la saturación real sigue diciendo saturado', () => {
  const err = new Error('AI: [503 ] The model is overloaded due to high demand.');
  assert.equal(isDeadline(err), false);
  assert.match(describeAiError(err), /Gemini is overloaded/);
  assert.match(retryMessage(err, 1, 2), /is overloaded/);
});

test('el aviso del modal cambia cada pocos segundos y luego vuelve a empezar', () => {
  assert.equal(busyNote(0), BUSY_NOTES[0]);
  assert.equal(busyNote(5), BUSY_NOTES[0]);
  assert.equal(busyNote(6), BUSY_NOTES[1]);
  assert.equal(busyNote(12), BUSY_NOTES[2]);
  assert.equal(busyNote(18), BUSY_NOTES[3]);
  assert.equal(busyNote(24), BUSY_NOTES[0]);
  assert.equal(new Set(BUSY_NOTES).size, BUSY_NOTES.length);
});

test('la página muestra el modal gris con spinner', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');
  assert.match(html, /id="busy"/);
  assert.match(html, /This can take from 20 seconds to a couple of minutes/);
  assert.match(html, /class="spinner"/);
  assert.match(css, /@keyframes spin/);
  assert.match(css, /\.busy\[hidden\]\s*\{\s*display:\s*none/);
});
