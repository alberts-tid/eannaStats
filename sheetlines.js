// Localiza el running score de un acta (filas de 40, como el impreso irlandés)
// y dice qué recuadro de la foto corresponde a cada marcador. No usa la red.

const ROWS = 40;

function linspace(a, b, n) {
  if (n <= 1) return [a];
  const out = [];
  for (let i = 0; i < n; i++) out.push(a + (b - a) * i / (n - 1));
  return out;
}

function integral(gray, width, height) {
  const ii = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += 255 - gray[y * width + x];
      ii[(y + 1) * (width + 1) + (x + 1)] = ii[y * (width + 1) + (x + 1)] + row;
    }
  }
  return ii;
}

function rectMean(ii, width, y0, y1, x0, x1) {
  const stride = width + 1;
  y0 = Math.max(0, y0 | 0);
  x0 = Math.max(0, x0 | 0);
  y1 = Math.min((ii.length / stride) - 1, y1 | 0);
  x1 = Math.min(width, x1 | 0);
  if (y1 <= y0 || x1 <= x0) return 0;
  const sum = ii[y1 * stride + x1] - ii[y0 * stride + x1] - ii[y1 * stride + x0] + ii[y0 * stride + x0];
  return sum / ((y1 - y0) * (x1 - x0));
}

function cellDarkness(ii, width, height, top, pitch, x, bw, row, block, a0, a1) {
  const y0 = top + row * pitch + 1;
  const y1 = y0 + pitch - 2;
  const x0 = x + block * bw + bw * a0;
  const x1 = x + block * bw + bw * a1;
  if (y0 < 0 || x0 < 0 || y1 >= height || x1 > width) return null;
  return rectMean(ii, width, y0, y1, x0, x1);
}

// La fila anotada tiene que estar más oscura que una fila vacía del mismo bloque.
// Así no se engancha a un bloque de texto denso (la lista de jugadores).
function contrast(ii, width, height, marks, markSet, top, pitch, x, bw, side) {
  if (pitch < 4 || bw < 8) return -1e9;
  const a0 = side === 'B' ? 0.62 : 0.04;
  const a1 = side === 'B' ? 0.98 : 0.36;
  let total = 0;
  let n = 0;
  for (const t of marks) {
    const row = (t - 1) % ROWS;
    const block = Math.floor((t - 1) / ROWS);
    const marked = cellDarkness(ii, width, height, top, pitch, x, bw, row, block, a0, a1);
    if (marked === null) return -1e9;
    let blank = null;
    for (let d = 1; d < 10 && blank === null; d++) {
      const r = row + d;
      if (r < ROWS && !markSet.has(r + 1 + block * ROWS)) blank = r;
    }
    if (blank === null) continue;
    const empty = cellDarkness(ii, width, height, top, pitch, x, bw, blank, block, a0, a1);
    if (empty === null) return -1e9;
    total += marked - empty;
    n += 1;
  }
  return n ? total / n : -1e9;
}

// Las rayas horizontales del impreso son más oscuras que el centro de la fila.
// Sirve para corregir el medio renglón que a veces se come el contraste de la tinta.
function ruleAlign(ii, width, height, top, pitch, x, bw) {
  const x1 = x + bw * 3;
  if (pitch < 4 || x < 0 || x1 > width) return -1e9;
  let acc = 0;
  let n = 0;
  for (let row = 0; row <= ROWS; row++) {
    const y = top + row * pitch;
    if (y < 2 || y + pitch >= height - 2) return -1e9;
    const rule = rectMean(ii, width, y - 1, y + 1, x, x1);
    const mid = rectMean(ii, width, y + pitch * 0.42, y + pitch * 0.58, x, x1);
    acc += rule - mid;
    n += 1;
  }
  return n ? acc / n : -1e9;
}

function snapToRules(ii, width, height, top, pitch, x, bw) {
  let best = null;
  for (const p of linspace(pitch * 0.96, pitch * 1.04, 9)) {
    for (const t of linspace(top - pitch * 0.45, top + pitch * 0.45, 13)) {
      const v = ruleAlign(ii, width, height, t, p, x, bw);
      if (!best || v > best.v) best = { v, top: t, pitch: p };
    }
  }
  const base = ruleAlign(ii, width, height, top, pitch, x, bw);
  if (!best || best.v < 8 || best.v < base + 4) return null;
  return best;
}

function bestOf(sample, pitches, tops, xs, bws) {
  let best = null;
  for (const pitch of pitches) {
    for (const top of tops) {
      for (const x of xs) {
        for (const bw of bws) {
          const v = sample(top, pitch, x, bw);
          if (!best || v > best.v) best = { v, pitch, top, x, bw };
        }
      }
    }
  }
  return best;
}

/**
 * gray: luminancia 0–255, fila a fila.
 * totals: marcadores acumulados que tienen tinta (el dorsal escrito).
 * Devuelve el recuadro de cada fila, o null si la foto no encaja con esta plantilla.
 */
export function locateRunningScore(gray, width, height, totals, { side = 'A' } = {}) {
  const marks = [...new Set(totals.map((t) => parseInt(t, 10)).filter((t) => t > 0 && t <= ROWS * 4))];
  if (marks.length < 6 || width < 40 || height < 80) return null;
  const ii = integral(gray, width, height);
  const markSet = new Set(marks);
  const sample = (top, pitch, x, bw) => contrast(ii, width, height, marks, markSet, top, pitch, x, bw, side);

  const coarse = bestOf(
    sample,
    linspace(height * 0.0072, height * 0.0128, 10),
    linspace(height * 0.28, height * 0.42, 14),
    linspace(width * 0.42, width * 0.62, 9),
    linspace(width * 0.10, width * 0.17, 7),
  );
  const around = (center, span, n) => linspace(center - span, center + span, n);
  const fine = bestOf(
    sample,
    around(coarse.pitch, height * 0.0009, 7),
    around(coarse.top, height * 0.015, 9),
    around(coarse.x, width * 0.025, 7),
    around(coarse.bw, width * 0.018, 7),
  );
  const shifted = sample(fine.top + fine.pitch * 0.5, fine.pitch, fine.x, fine.bw);
  if (fine.v < 8 || fine.v < shifted + 4) return null;
  const snapped = snapToRules(ii, width, height, fine.top, fine.pitch, fine.x, fine.bw);
  if (snapped && sample(snapped.top, snapped.pitch, fine.x, fine.bw) > fine.v * 0.55) {
    fine.top = snapped.top;
    fine.pitch = snapped.pitch;
  }
  return { top: fine.top, pitch: fine.pitch, x: fine.x, blockWidth: fine.bw, rows: ROWS, score: fine.v };
}

/** Recuadro, en píxeles de `gray`, de la línea real que contiene ese marcador. */
export function lineBox(grid, total) {
  const t = parseInt(total, 10);
  if (!grid || !Number.isFinite(t) || t < 1) return null;
  const row = (t - 1) % grid.rows;
  const block = Math.floor((t - 1) / grid.rows);
  const padX = grid.blockWidth * 0.2;
  const padY = grid.pitch * 0.12;
  return {
    x: grid.x + block * grid.blockWidth - padX,
    y: grid.top + row * grid.pitch - padY,
    w: grid.blockWidth + padX * 1.35,
    h: grid.pitch + padY * 2,
    row,
    block,
  };
}
