import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('la foto va dentro del recuadro y solo hay el botón de analizar', () => {
  const drop = html.slice(html.indexOf('id="drop"'), html.indexOf('</label>'));
  assert.match(drop, /id="preview"/);
  assert.doesNotMatch(html, /id="preview-wrap"/);
  assert.match(html, />Analizar acta</);
  assert.doesNotMatch(html, /btn-demo|Probar con un ejemplo|Analizar con IA/);
});

test('subir y borrar actas queda tras el login; partidos y acumulado se ven sin sesión', () => {
  assert.match(html, /id="tab-acta"[^>]*hidden/);
  assert.match(html, /id="view-acta" class="view" hidden/);
  assert.match(html, /id="view-games" class="view"/);
  assert.doesNotMatch(html, /id="view-games" class="view" hidden/);
  assert.match(html, /Eliminar acta/);
  assert.match(html, /id="btn-delete-public"/);
  assert.match(html, /id="public-game"/);
  assert.match(html, /lectura pública/);
  const games = html.slice(html.indexOf('id="view-games"'), html.indexOf('id="view-totals"'));
  assert.doesNotMatch(games, /team-select|public-tabs/);
  const totals = html.slice(html.indexOf('id="view-totals"'));
  assert.doesNotMatch(totals, /team-select/);
  assert.match(totals, /Éanna · acumulado/);
});

test('el marcador leído es una columna de running score', () => {
  assert.match(html, /Running score/);
  assert.match(html, /id="editor" class="running"/);
  assert.match(html, /línea real de la foto/);
  assert.doesNotMatch(html, /id="warnings"/);
});
