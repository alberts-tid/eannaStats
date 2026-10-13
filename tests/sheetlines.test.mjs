import assert from 'node:assert/strict';
import test from 'node:test';
import { lineBox, locateRunningScore, missingInkedTotals } from '../sheetlines.js';

function paintSheet() {
  const width = 320;
  const height = 640;
  const gray = new Uint8Array(width * height).fill(238);
  const top = 200;
  const pitch = 7;
  const x = 160;
  const bw = 42;
  const totals = [2, 6, 15, 36, 42, 86, 100];
  for (const t of totals) {
    const row = (t - 1) % 40;
    const block = Math.floor((t - 1) / 40);
    const y0 = top + row * pitch + 1;
    const x0 = x + block * bw + 3;
    for (let yy = y0; yy < y0 + pitch - 2; yy++) {
      for (let xx = x0; xx < x0 + 12; xx++) gray[yy * width + xx] = 25;
    }
  }
  return { gray, width, height, top, pitch, x, bw, totals };
}

test('encuentra la fila real de cada marcador en una plantilla de 40', () => {
  const sheet = paintSheet();
  const grid = locateRunningScore(sheet.gray, sheet.width, sheet.height, sheet.totals, { side: 'A' });
  assert.ok(grid, 'no localizó el running score');
  assert.ok(Math.abs(grid.top - sheet.top) < 2, `top ${grid.top}`);
  assert.ok(Math.abs(grid.pitch - sheet.pitch) < 0.6, `pitch ${grid.pitch}`);
  assert.ok(Math.abs(grid.x - sheet.x) < 8, `x ${grid.x}`);
  const box15 = lineBox(grid, 15);
  const box86 = lineBox(grid, 86);
  assert.equal(box15.row, 14);
  assert.equal(box15.block, 0);
  assert.equal(box86.row, 5);
  assert.equal(box86.block, 2);
  assert.ok(box86.x > box15.x);
  assert.ok(Math.abs((box15.y + box15.h / 2) - (sheet.top + 14.5 * sheet.pitch)) < 3);
});

test('recupera la línea del 2 si la lectura empieza más tarde', () => {
  const sheet = paintSheet();
  const grid = locateRunningScore(sheet.gray, sheet.width, sheet.height, sheet.totals, { side: 'A' });
  const missing = missingInkedTotals(sheet.gray, sheet.width, sheet.height, grid, [6, 15, 36], 'A');
  assert.deepEqual(missing, [2]);
});

test('una foto en blanco no inventa líneas', () => {
  const gray = new Uint8Array(200 * 300).fill(240);
  assert.equal(locateRunningScore(gray, 200, 300, [2, 4, 6, 8, 10, 12]), null);
});
