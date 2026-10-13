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

test('el marcador leído es una columna de running score', () => {
  assert.match(html, /Running score/);
  assert.match(html, /id="editor" class="running"/);
  assert.doesNotMatch(html, /id="warnings"/);
});
