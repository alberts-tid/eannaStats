import { QUARTER_LABELS } from './boxscore.js';

const C = {
  page: '#F3F4F6',
  card: '#FFFFFF',
  header: '#111318',
  accent: '#E8A317',
  text: '#111318',
  muted: '#6B7280',
  zero: '#B0B6BE',
  line: '#E5E7EB',
  stripe: '#F9FAFB',
  offRoster: '#FFF8EC',
  chip: '#EEF0F3',
};

const FONT = '"Inter", "Helvetica Neue", Arial, sans-serif';

function font(weight, size) {
  return `${weight} ${size}px ${FONT}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function playerLabel(row) {
  if (row.name) return row.name;
  if (row.number === '?') return 'Unreadable jersey';
  return row.onRoster ? `#${row.number}` : `Jersey written as ${row.number}`;
}

export function defaultNotes(team) {
  const notes = ['2PM, 3PM and FTM are made baskets, not points. Quarter columns are points.'];
  const off = team.rows.filter((r) => !r.onRoster && r.pts > 0);
  for (const r of off) {
    notes.push(r.number === '?'
      ? `${r.pts} points have an unreadable jersey number.`
      : `Jersey ${r.number} is not on the roster (${r.pts} pts). Check the scoresheet.`);
  }
  if (team.rows.some((r) => r.other > 0)) {
    notes.push('Some score jumps are not 1, 2 or 3 points; they count as points but not as made baskets.');
  }
  return notes;
}

/**
 * Dibuja la tabla de estadísticas en un canvas (mismo diseño que el JPG original).
 * opts: { title, subtitle, score: '114 – 38', badge: 'FINAL', notes: [] }
 */
export function renderBoxScoreCanvas(team, opts = {}) {
  const S = 2;
  const W = 1480;
  const margin = 36;
  const headerH = 132;
  const gap = 16;
  const headRowH = 42;
  const rowH = 46;
  const totalH = 50;
  const against = opts.against || null;
  const notes = opts.notes || defaultNotes(team);

  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font(400, 15);
  const cardW = W - margin * 2;
  const noteLines = notes.flatMap((n) => wrap(measure, n, cardW - 48));
  const notesH = noteLines.length ? 24 + noteLines.length * 22 : 0;
  const bottomPad = 22;
  const againstH = against ? rowH : 0;
  const tableH = headRowH + rowH * team.rows.length + totalH + againstH;
  const H = margin + headerH + gap + tableH + notesH + bottomPad + margin;

  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);
  ctx.textBaseline = 'middle';

  ctx.fillStyle = C.page;
  ctx.fillRect(0, 0, W, H);

  const x0 = margin;
  let y = margin;
  roundRect(ctx, x0, y, cardW, headerH, 18);
  ctx.fillStyle = C.header;
  ctx.fill();
  ctx.fillStyle = C.accent;
  ctx.fillRect(x0 + 32, y + headerH - 26, 64, 4);

  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(700, 40);
  ctx.textAlign = 'left';
  ctx.fillText(opts.title || team.name || 'Box score', x0 + 32, y + 48);
  ctx.fillStyle = '#C9CDD4';
  ctx.font = font(500, 18);
  ctx.fillText(opts.subtitle || '', x0 + 32, y + 86);

  if (opts.score) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = font(700, 50);
    ctx.fillText(opts.score, x0 + cardW - 32, y + 56);
    ctx.fillStyle = C.accent;
    ctx.font = font(700, 15);
    ctx.fillText(opts.badge || 'FINAL', x0 + cardW - 32, y + 98);
  }

  y += headerH + gap;
  const cardH = tableH + notesH + bottomPad;
  roundRect(ctx, x0, y, cardW, cardH, 18);
  ctx.fillStyle = C.card;
  ctx.fill();

  const fixed = [
    ['PTS', 78], ['2PM', 72], ['3PM', 72], ['FTM', 72], ['FOULS', 84],
    ...QUARTER_LABELS.map((q) => [q, 72]),
  ];
  const padX = 24;
  const fixedW = fixed.reduce((a, [, w]) => a + w, 0);
  const playerW = cardW - padX * 2 - fixedW;
  const cols = [];
  let cx = x0 + padX + playerW;
  for (const [label, w] of fixed) {
    cols.push({ label, x: cx, w });
    cx += w;
  }

  ctx.font = font(700, 13);
  ctx.fillStyle = C.muted;
  ctx.textAlign = 'left';
  ctx.fillText('PLAYER', x0 + padX + 4, y + headRowH / 2 + 4);
  ctx.textAlign = 'center';
  for (const c of cols) ctx.fillText(c.label, c.x + c.w / 2, y + headRowH / 2 + 4);
  y += headRowH;

  const cell = (value, c, rowY, h, opt = {}) => {
    const isZero = value === 0;
    ctx.fillStyle = opt.color || (isZero ? C.zero : C.text);
    ctx.font = font(opt.weight || 600, opt.size || 18);
    ctx.textAlign = 'center';
    ctx.fillText(value === null || value === undefined ? '—' : String(value), c.x + c.w / 2, rowY + h / 2);
  };

  team.rows.forEach((r, i) => {
    if (!r.onRoster) {
      ctx.fillStyle = C.offRoster;
      ctx.fillRect(x0, y, cardW, rowH);
    } else if (i % 2 === 1) {
      ctx.fillStyle = C.stripe;
      ctx.fillRect(x0, y, cardW, rowH);
    }
    ctx.fillStyle = C.line;
    ctx.fillRect(x0 + padX, y + rowH - 1, cardW - padX * 2, 1);

    const chipW = 44;
    roundRect(ctx, x0 + padX, y + 9, chipW, rowH - 18, 7);
    ctx.fillStyle = r.onRoster ? C.chip : '#F6E3C1';
    ctx.fill();
    ctx.fillStyle = C.text;
    ctx.font = font(700, 15);
    ctx.textAlign = 'center';
    ctx.fillText(r.number, x0 + padX + chipW / 2, y + rowH / 2 + 1);

    ctx.textAlign = 'left';
    ctx.font = font(600, 18);
    ctx.fillStyle = C.text;
    let label = playerLabel(r);
    const maxLabel = playerW - chipW - 24;
    while (ctx.measureText(label).width > maxLabel && label.length > 3) label = `${label.slice(0, -2)}…`;
    ctx.fillText(label, x0 + padX + chipW + 14, y + rowH / 2 + 1);

    const vals = [r.pts, r.fg2, r.fg3, r.ftm, r.fouls, ...r.quarters];
    vals.forEach((v, k) => cell(v, cols[k], y, rowH, k === 0 ? { weight: 700, size: 20 } : {}));
    y += rowH;
  });

  ctx.fillStyle = C.header;
  ctx.fillRect(x0, y, cardW, totalH);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = font(700, 16);
  ctx.textAlign = 'left';
  ctx.fillText('TOTAL', x0 + padX + 4, y + totalH / 2 + 1);
  const t = team.totals;
  [t.pts, t.fg2, t.fg3, t.ftm, t.fouls, ...t.quarters].forEach((v, k) => {
    cell(v, cols[k], y, totalH, { color: '#FFFFFF', weight: 700, size: k === 0 ? 20 : 18 });
  });
  y += totalH;

  if (against) {
    ctx.fillStyle = '#EEF2FF';
    ctx.fillRect(x0, y, cardW, againstH);
    ctx.fillStyle = C.text;
    ctx.font = font(600, 16);
    ctx.textAlign = 'left';
    let label = `En contra${against.name ? ` · ${against.name}` : ''}`;
    const maxLabel = playerW - 12;
    while (ctx.measureText(label).width > maxLabel && label.length > 12) label = `${label.slice(0, -2)}…`;
    ctx.fillText(label, x0 + padX + 4, y + againstH / 2 + 1);
    const quarters = against.quarters || [null, null, null, null];
    [against.points, against.fg2, against.fg3, against.ftm, against.fouls, ...quarters].forEach((v, k) => {
      cell(v, cols[k], y, againstH, { color: C.text, weight: 600, size: k === 0 ? 20 : 18 });
    });
    y += againstH;
  }

  if (noteLines.length) {
    y += 22;
    ctx.fillStyle = C.muted;
    ctx.font = font(400, 15);
    ctx.textAlign = 'left';
    noteLines.forEach((line, i) => ctx.fillText(line, x0 + 24, y + i * 22 + 4));
  }
  return canvas;
}
