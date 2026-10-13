import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  initializeAppCheck, ReCaptchaEnterpriseProvider,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app-check.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {
  getAI, getGenerativeModel, GoogleAIBackend, Schema, ThinkingLevel,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-ai.js';
import {
  computeBoxScore, aggregateTeam, listTeams, teamKey, findEannaKey, opponentLine, QUARTER_LABELS,
} from './boxscore.js';
import { initStore, listGames, saveGame, deleteGame } from './store.js';
import { EXTRACTION_PROMPT, buildResponseSchema } from './prompt.js';
import { renderBoxScoreCanvas, playerLabel, defaultNotes } from './render.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';
import { lineBox, locateRunningScore, missingInkedTotals } from './sheetlines.js';
import { busyNote, describeAiError, isTransient, retryMessage } from './ai-errors.js';

const DEFAULT_MODEL = 'gemini-3.7-flash';
const MAX_SIDE = 1600;
const DETECT_WIDTH = 720;

const params = new URLSearchParams(location.search);
// ?emulator usa los emuladores locales de Firebase (Auth 9099, Firestore 8080) para pruebas.
const emulatorHost = params.has('emulator') ? (params.get('emulator') || '127.0.0.1') : null;
const firestorePort = Number(params.get('fs') || 8080);
const authPort = Number(params.get('auth') || 9099);

const app = initializeApp(firebaseConfig);
if (appCheckSiteKey && !emulatorHost) {
  // En localhost reCAPTCHA no da tokens válidos: el SDK imprime en la consola un token de depuración
  // que hay que registrar en Firebase Console → App Check → Apps → Administrar tokens de depuración.
  if (['localhost', '127.0.0.1'].includes(location.hostname)) self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(appCheckSiteKey),
    isTokenAutoRefreshEnabled: true,
  });
}
const auth = getAuth(app);
if (emulatorHost) connectAuthEmulator(auth, `http://${emulatorHost}:${authPort}`, { disableWarnings: true });
initStore(app, { emulatorHost, firestorePort });
// AI Logic tiene la protección contra reutilización de App Check: solo acepta tokens de un solo uso.
const ai = getAI(app, { backend: new GoogleAIBackend(), useLimitedUseAppCheckTokens: true });

const $ = (id) => document.getElementById(id);
const state = {
  image: null,
  extraction: null,
  box: null,
  teamIndex: 0,
  user: null,
  currentId: null,
  games: [],
  gamesLoaded: false,
  teamKey: localStorage.getItem('acta.team') || '',
  view: 'games',
  readingId: null,
  readTeam: 0,
};

const ADMIN_EMAIL = 'albertsinfreu@gmail.com';

function canManage(game) {
  return !!(state.user && game && (game.createdBy === state.user.uid || state.user.email === ADMIN_EMAIL));
}

function setStatus(msg, kind = 'info') {
  const el = $('status');
  el.textContent = msg || '';
  el.dataset.kind = kind;
  el.hidden = !msg;
}

function slugify(name) {
  return (name || 'equipo').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'equipo';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Auth ----------
onAuthStateChanged(auth, (user) => {
  state.user = user;
  $('login-form').hidden = !!user;
  $('user-box').hidden = !user;
  $('user-email').textContent = user?.email || '';
  updateAnalyzeButton();
  updateZone();
  updateSaveButtons();
  renderSaved();
  refreshGames();
});

$('login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('login-error').textContent = '';
  try {
    await signInWithEmailAndPassword(auth, $('login-email').value.trim(), $('login-password').value);
  } catch (err) {
    $('login-error').textContent = 'No se ha podido entrar: revisa el email y la contraseña.';
    console.error(err);
  }
});
$('btn-logout').addEventListener('click', () => signOut(auth));

// ---------- Image ----------
function updateAnalyzeButton() {
  $('btn-analyze').disabled = !(state.user && state.image);
  const hint = !state.user
    ? 'Inicia sesión para analizar el acta.'
    : (!state.image ? 'Sube primero una foto del acta.' : '');
  $('analyze-hint').textContent = hint;
  $('analyze-hint').hidden = !hint;
}

async function loadImage(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('El archivo no es una imagen.', 'error');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  await img.decode();
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  URL.revokeObjectURL(url);
  state.image = { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', name: file.name, sheet: buildSheet(canvas) };
  $('preview').src = dataUrl;
  $('preview').hidden = false;
  $('drop-empty').hidden = true;
  $('drop').classList.add('has-file');
  $('drop').title = 'Cambiar foto';
  setStatus('');
  updateAnalyzeButton();
  if (state.extraction && !state.currentId) {
    recoverSkippedLines();
    recompute();
  }
}

function buildSheet(source) {
  const scale = Math.min(1, DETECT_WIDTH / source.width);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    gray[i] = (data[p] * 54 + data[p + 1] * 183 + data[p + 2] * 19) >> 8;
  }
  return { canvas, gray, width, height };
}

function paintSheetLine(canvas, source, box) {
  const sx = Math.max(0, Math.floor(box.x));
  const sy = Math.max(0, Math.floor(box.y));
  const ex = Math.min(source.width, Math.ceil(box.x + box.w));
  const ey = Math.min(source.height, Math.ceil(box.y + box.h));
  const sw = Math.max(1, ex - sx);
  const sh = Math.max(1, ey - sy);
  const zoom = 3;
  canvas.width = sw * zoom;
  canvas.height = sh * zoom;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

let sheetCache = null;

function sheetGrid(sheet) {
  const teams = state.extraction?.teams || [];
  const richer = [...teams].sort((a, b) => (b.scoring?.length || 0) - (a.scoring?.length || 0))[0];
  const side = richer?.side === 'B' ? 'B' : 'A';
  const totals = (richer?.scoring || []).map((e) => parseInt(e.total, 10)).filter((t) => t > 0);
  const key = `${side}|${totals.join(',')}|${sheet.width}x${sheet.height}`;
  if (!sheetCache || sheetCache.key !== key || sheetCache.sheet !== sheet) {
    sheetCache = { key, sheet, grid: locateRunningScore(sheet.gray, sheet.width, sheet.height, totals, { side }) };
  }
  return sheetCache.grid;
}

function runningPhoto(team) {
  const sheet = state.image?.sheet;
  if (!sheet || state.currentId || !team?.scoring?.length) return null;
  const grid = sheetGrid(sheet);
  return grid ? { grid, canvas: sheet.canvas } : null;
}

// Si la lectura se salta una fila escrita (el 2, u otra), la añade para que se pueda corregir.
function recoverSkippedLines() {
  const sheet = state.image?.sheet;
  if (!sheet || state.currentId || !state.extraction?.teams) return false;
  const grid = sheetGrid(sheet);
  if (!grid) return false;
  let added = false;
  for (const team of state.extraction.teams) {
    const side = team.side === 'B' ? 'B' : 'A';
    const existing = (team.scoring || []).map((e) => e.total);
    const missing = missingInkedTotals(sheet.gray, sheet.width, sheet.height, grid, existing, side, team.finalScore);
    if (!missing.length) continue;
    team.scoring = team.scoring || [];
    for (const total of missing) {
      team.scoring.push({ total, jersey: '', threePointer: false, freeThrow: false });
    }
    added = true;
  }
  if (added) sheetCache = null;
  return added;
}

$('file').addEventListener('change', (ev) => loadImage(ev.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => loadImage(ev.dataTransfer.files[0]));

// ---------- AI ----------
localStorage.removeItem('acta.provider');
localStorage.removeItem('acta.openrouterKey');
localStorage.removeItem('acta.model.openrouter');
$('model').value = localStorage.getItem('acta.model.gemini') || localStorage.getItem('acta.model') || DEFAULT_MODEL;
$('model').addEventListener('change', () => localStorage.setItem('acta.model.gemini', $('model').value.trim()));

let busyTimer = null;

function showBusy() {
  $('busy').hidden = false;
  document.body.classList.add('busy-open');
  $('busy-title').textContent = 'Analizando el acta con IA';
  $('busy-detail').dataset.locked = '';
  const started = Date.now();
  const tick = () => {
    const seconds = Math.round((Date.now() - started) / 1000);
    $('busy-elapsed').textContent = `Tiempo transcurrido: ${seconds} s`;
    if (!$('busy-detail').dataset.locked) $('busy-detail').textContent = busyNote(seconds);
  };
  tick();
  busyTimer = setInterval(tick, 1000);
}

function setBusyDetail(text) {
  $('busy-detail').dataset.locked = '1';
  $('busy-detail').textContent = text;
}

function hideBusy() {
  clearInterval(busyTimer);
  busyTimer = null;
  $('busy').hidden = true;
  document.body.classList.remove('busy-open');
}

async function analyze() {
  const modelName = $('model').value.trim() || DEFAULT_MODEL;
  const model = getGenerativeModel(ai, {
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildResponseSchema(Schema),
      temperature: 0,
      // gemini-3.7-flash rechaza MINIMAL con un 400. HIGH alarga tanto la
      // respuesta que Google la corta con 503 «Deadline expired».
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
  }, { timeout: 180000 });
  const extra = $('hint').value.trim();
  const prompt = extra ? `${EXTRACTION_PROMPT}\n\nExtra context from the user: ${extra}` : EXTRACTION_PROMPT;
  const parts = [prompt, { inlineData: { data: state.image.base64, mimeType: state.image.mimeType } }];
  const delays = [8000, 20000];
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await model.generateContent(parts);
      return JSON.parse(result.response.text());
    } catch (err) {
      if (attempt >= delays.length || !isTransient(err)) throw err;
      setBusyDetail(retryMessage(err, attempt + 1, delays.length));
      await new Promise((r) => setTimeout(r, delays[attempt]));
      $('busy-detail').dataset.locked = '';
    }
  }
}

$('btn-analyze').addEventListener('click', async () => {
  const btn = $('btn-analyze');
  btn.disabled = true;
  setStatus('');
  showBusy();
  try {
    const extraction = await analyze();
    setExtraction(extraction);
    setStatus('Acta analizada. Revisa los avisos y corrige dorsales si hace falta.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(describeAiError(err, $('model').value.trim() || DEFAULT_MODEL), 'error');
  } finally {
    hideBusy();
    updateAnalyzeButton();
  }
});

async function loadDemo() {
  const res = await fetch('fixtures/eanna-drogheda.json');
  setExtraction(await res.json());
  setStatus('Ejemplo cargado (Éanna BC vs Drogheda Wolves), sin llamar a la IA.', 'ok');
}

// ---------- Results ----------
function setExtraction(extraction, { savedId = null } = {}) {
  state.extraction = extraction;
  state.currentId = savedId;
  const teams = extraction.teams || [];
  const selected = teams.findIndex((t) => state.teamKey && teamKey(t.name) === state.teamKey);
  const firstWithScoring = teams.findIndex((t) => (t.scoring || []).length);
  state.teamIndex = Math.max(0, selected >= 0 ? selected : firstWithScoring);
  $('save-status').hidden = true;
  updateSavedBanner();
  updateSaveButtons();
  recoverSkippedLines();
  $('json').value = JSON.stringify(extraction, null, 2);
  recompute();
}

function recompute() {
  state.box = computeBoxScore(state.extraction);
  renderResults();
}

function againstFoot(box, teamIndex = state.teamIndex) {
  const other = box.teams.find((_, i) => i !== teamIndex);
  const line = opponentLine(other);
  if (!line) return '';
  const num = (v) => (v === null || v === undefined ? '—' : v);
  const quarters = line.quarters || [null, null, null, null];
  const label = `En contra${line.name ? ` · ${line.name}` : ''}`;
  return `<tr class="against"><td></td><td>${esc(label)}</td>${[line.points, line.fg2, line.fg3, line.ftm, line.fouls, ...quarters].map((v) => `<td>${num(v)}</td>`).join('')}</tr>`;
}

function gameSubtitle(box, teamIndex = state.teamIndex) {
  const g = box.game || {};
  const other = box.teams.find((_, i) => i !== teamIndex);
  return [g.competition, g.venue, other?.name ? `vs ${other.name}` : '', g.date]
    .filter(Boolean).join(' · ');
}

function scoreLine(box, teamIndex = state.teamIndex) {
  const t = box.teams[teamIndex];
  const other = box.teams.find((_, i) => i !== teamIndex);
  if (!t) return '';
  return other ? `${t.finalScore} – ${other.finalScore}` : String(t.finalScore);
}

function boxTableHtml(box, teamIndex) {
  const team = box.teams[teamIndex];
  if (!team) return '';
  if (!team.hasScoring) return '<p class="muted">No se ha leído ninguna anotación de este equipo en el marcador.</p>';
  const head = ['#', 'Player', 'PTS', '2PM', '3PM', 'FTM', 'Fouls', ...QUARTER_LABELS];
  const num = (v) => (v === null || v === undefined ? '—' : v);
  const cls = (v) => (v === 0 ? 'zero' : '');
  const body = team.rows.map((r) => `
    <tr class="${r.onRoster ? '' : 'off'}">
      <td><span class="chip">${esc(r.number)}</span></td>
      <td class="name">${esc(playerLabel(r))}</td>
      ${[r.pts, r.fg2, r.fg3, r.ftm, r.fouls, ...r.quarters].map((v, k) => `<td class="${cls(v)} ${k === 0 ? 'pts' : ''}">${num(v)}</td>`).join('')}
    </tr>`).join('');
  const t = team.totals;
  const own = `<tr><td></td><td>TOTAL</td>${[t.pts, t.fg2, t.fg3, t.ftm, t.fouls, ...t.quarters].map((v) => `<td>${v}</td>`).join('')}</tr>`;
  return `
    <table class="box">
      <thead><tr>${head.map((h, i) => `<th class="${i < 2 ? 'left' : ''}">${h}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot>${own}${againstFoot(box, teamIndex)}</tfoot>
    </table>
    <ul class="notes">${defaultNotes(team).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

function renderResults() {
  const box = state.box;
  $('results').hidden = false;
  const tabs = $('team-tabs');
  tabs.innerHTML = box.teams.map((t, i) => `
    <button type="button" class="tab ${i === state.teamIndex ? 'active' : ''}" data-i="${i}">
      ${esc(t.name || `Equipo ${t.side || i + 1}`)} <span>${t.finalScore}</span>
    </button>`).join('');
  tabs.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.teamIndex = +b.dataset.i;
    renderResults();
  }));

  const team = box.teams[state.teamIndex];
  if (!team) return;
  $('game-title').textContent = team.name || 'Equipo';
  $('game-sub').textContent = gameSubtitle(box);
  $('game-score').textContent = scoreLine(box);
  $('table-wrap').innerHTML = boxTableHtml(box, state.teamIndex);
  renderEditor();
}

function mentionsToken(text, token) {
  const safe = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\d)${safe}(?!\\d)`).test(String(text));
}

function renderEditor() {
  const team = state.extraction.teams?.[state.teamIndex];
  const boxTeam = state.box.teams[state.teamIndex];
  const plays = boxTeam.plays.map((p) => ({ ...p, doubts: [...(p.doubts || [])] }));
  const byIdx = new Map(plays.map((p) => [p.idx, p]));
  const notes = state.extraction.notes || [];
  const leftoverNotes = [];
  for (const note of notes) {
    const hit = plays.find((p) => mentionsToken(note, p.total) || (p.jersey && p.jersey !== '?' && mentionsToken(note, p.jersey)));
    if (hit) hit.doubts.push(`IA: ${note}`);
    else leftoverNotes.push(`IA: ${note}`);
  }
  const used = new Set(plays.flatMap((p) => p.doubts));
  const general = [...boxTeam.warnings.filter((w) => !used.has(w)), ...leftoverNotes];
  const rows = (team?.scoring || []).map((e, idx) => ({ e, idx, play: byIdx.get(idx) }))
    .sort((a, b) => (+a.e.total || 0) - (+b.e.total || 0) || a.idx - b.idx);
  const kindLabel = (play) => {
    if (!play) return '';
    if (play.kind === 'SKIP') return '—';
    if (play.kind === 'OTHER') return `+${play.points}?`;
    if (play.kind === 'FT') return '+1';
    if (play.kind === '2PT') return '+2';
    return '+3';
  };
  const quarterMark = (play) => {
    if (!play || play.kind === 'SKIP' || play.quarter == null) return '';
    const end = boxTeam.quarterEnds?.[play.quarter];
    return end === play.total && Number.isFinite(end) ? QUARTER_LABELS[play.quarter] : '';
  };
  const photo = runningPhoto(team);
  $('editor').classList.toggle('has-photo', !!photo);
  const body = rows.map(({ e, idx, play }) => {
    const doubts = play?.doubts || [];
    const end = quarterMark(play);
    return `
    <div class="run ${doubts.length || play?.kind === 'OTHER' || play?.kind === 'SKIP' ? 'bad' : ''} ${end ? 'end' : ''}" data-idx="${idx}">
      ${photo ? `<canvas class="run-photo" aria-label="Línea del acta del marcador ${esc(e.total)}"></canvas>` : ''}
      <input type="number" class="run-total" value="${esc(e.total)}" min="1" aria-label="Marcador acumulado">
      <div class="run-player ${e.threePointer ? 'circled' : ''}">
        <input type="text" class="run-jersey" value="${esc(e.jersey)}" aria-label="Dorsal" inputmode="numeric">
        <button type="button" class="run-three" aria-pressed="${e.threePointer ? 'true' : 'false'}" aria-label="Dorsal rodeado: triple" title="Dorsal rodeado: triple"></button>
      </div>
      <span class="run-kind">${esc(kindLabel(play))}${end ? ` · ${end}` : ''}</span>
      <p class="run-doubt">${doubts.map((d) => esc(d)).join(' ')}</p>
      <button type="button" class="run-del" title="Eliminar anotación">×</button>
    </div>`;
  }).join('');
  const extra = general.length
    ? `<ul class="running-extra">${general.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';
  const head = photo
    ? '<span>Acta</span><span>Total</span><span>Nº</span><span></span><span>Duda</span><span></span>'
    : '<span>Total</span><span>Nº</span><span></span><span>Duda</span><span></span>';
  $('editor').innerHTML = `
    <div class="running-title">Running score · ${esc(team?.name || 'Equipo')}</div>
    <div class="run run-head">${head}</div>
    ${body || '<p class="muted" style="padding:12px">Sin anotaciones.</p>'}
    ${extra}`;

  $('editor').querySelectorAll('.run[data-idx]').forEach((row) => {
    const entry = team.scoring[+row.dataset.idx];
    if (photo) {
      const box = lineBox(photo.grid, entry.total);
      const canvas = row.querySelector('.run-photo');
      if (canvas && box) paintSheetLine(canvas, photo.canvas, box);
    }
    row.querySelector('.run-total').addEventListener('change', (ev) => { entry.total = parseInt(ev.target.value, 10); syncJson(); });
    const jersey = row.querySelector('.run-jersey');
    jersey.addEventListener('click', (ev) => ev.stopPropagation());
    jersey.addEventListener('change', (ev) => { entry.jersey = ev.target.value.trim(); syncJson(); });
    row.querySelector('.run-three').addEventListener('click', () => { entry.threePointer = !entry.threePointer; syncJson(); });
    row.querySelector('.run-del').addEventListener('click', () => { team.scoring.splice(+row.dataset.idx, 1); syncJson(); });
  });
}

function syncJson() {
  $('json').value = JSON.stringify(state.extraction, null, 2);
  recompute();
}

$('btn-add-event').addEventListener('click', () => {
  const team = state.extraction?.teams?.[state.teamIndex];
  if (!team) return;
  team.scoring = team.scoring || [];
  const last = team.scoring.reduce((m, e) => Math.max(m, +e.total || 0), 0);
  team.scoring.push({ total: last + 2, jersey: '', threePointer: false });
  syncJson();
});

$('btn-apply-json').addEventListener('click', () => {
  try {
    state.extraction = JSON.parse($('json').value);
    recompute();
    setStatus('JSON aplicado.', 'ok');
  } catch (err) {
    setStatus(`JSON no válido: ${err.message}`, 'error');
  }
});

async function downloadJpg(box, teamIndex) {
  await document.fonts.ready;
  const team = box.teams[teamIndex];
  const canvas = renderBoxScoreCanvas(team, {
    title: team.name,
    subtitle: gameSubtitle(box, teamIndex),
    score: scoreLine(box, teamIndex),
    badge: 'FINAL',
    against: opponentLine(box.teams.find((_, i) => i !== teamIndex)),
  });
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(team.name)}-box-score.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/jpeg', 0.93);
}

function downloadCsv(box, teamIndex) {
  const team = box.teams[teamIndex];
  const header = ['Number', 'Player', 'PTS', '2PM', '3PM', 'FTM', 'Fouls', ...QUARTER_LABELS];
  const lines = [header, ...team.rows.map((r) => [r.number, playerLabel(r), r.pts, r.fg2, r.fg3, r.ftm, r.fouls ?? '', ...r.quarters])];
  const t = team.totals;
  lines.push(['', 'TOTAL', t.pts, t.fg2, t.fg3, t.ftm, t.fouls, ...t.quarters]);
  const against = opponentLine(box.teams.find((_, i) => i !== teamIndex));
  if (against) {
    const cell = (v) => (v === null || v === undefined ? '' : v);
    const quarters = against.quarters || [null, null, null, null];
    lines.push(['', `En contra${against.name ? ` · ${against.name}` : ''}`, cell(against.points), cell(against.fg2), cell(against.fg3), cell(against.ftm), cell(against.fouls), ...quarters.map(cell)]);
  }
  const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${slugify(team.name)}-box-score.csv`;
  a.click();
}

$('btn-jpg').addEventListener('click', () => downloadJpg(state.box, state.teamIndex));
$('btn-csv').addEventListener('click', () => downloadCsv(state.box, state.teamIndex));

// ---------- Partidos guardados ----------
function setSaveStatus(msg, kind = 'info') {
  const el = $('save-status');
  el.textContent = msg || '';
  el.dataset.kind = kind;
  el.hidden = !msg;
}

function savedGame() {
  return state.games.find((g) => g.id === state.currentId) || null;
}

function updateSavedBanner() {
  const saved = !!state.currentId;
  $('saved-banner').hidden = !saved;
  $('upload-card').hidden = saved;
  $('results-title').textContent = saved ? 'Partido guardado' : '2. Estadísticas';
  if (saved) {
    const names = (state.extraction?.teams || []).map((t) => t.name).filter(Boolean).join(' vs ');
    $('saved-banner-text').textContent = `Viendo ${names || 'partido'}${state.extraction?.game?.date ? ` (${state.extraction.game.date})` : ''}. Los cambios se guardan con «Guardar cambios».`;
  }
}

function updateSaveButtons() {
  const btn = $('btn-save');
  btn.textContent = state.currentId ? 'Guardar cambios' : 'Guardar partido';
  btn.disabled = !state.user || !state.extraction;
  btn.title = state.user ? '' : 'Inicia sesión para guardar';
  const game = savedGame();
  $('btn-delete').hidden = !canManage(game);
}

$('btn-save').addEventListener('click', async () => {
  if (!state.user || !state.extraction) return;
  const btn = $('btn-save');
  btn.disabled = true;
  setSaveStatus('Guardando…');
  try {
    const wasNew = !state.currentId;
    const id = await saveGame(state.extraction, state.user, state.currentId);
    state.currentId = id;
    const team = state.extraction.teams?.[state.teamIndex];
    if (team?.name && !state.teamKey) setTeam(teamKey(team.name));
    await refreshGames();
    updateSavedBanner();
    setSaveStatus(wasNew ? 'Partido guardado. Ya cuenta en «Partidos» y «Acumulado».' : 'Cambios guardados.', 'ok');
  } catch (err) {
    console.error(err);
    setSaveStatus(/permission/i.test(String(err?.code || err?.message))
      ? 'Firestore ha denegado el permiso. ¿Están desplegadas las reglas de acta_partits?'
      : `No se ha podido guardar: ${err.message || err}`, 'error');
  } finally {
    updateSaveButtons();
  }
});

async function removeGame(id) {
  const game = state.games.find((g) => g.id === id);
  if (!canManage(game)) return;
  if (!confirm('¿Eliminar este partido guardado? Dejará de contar en el acumulado.')) return;
  try {
    await deleteGame(id);
    if (state.currentId === id) resetToUpload();
    if (state.readingId === id) state.readingId = null;
    await refreshGames();
    setView('games');
  } catch (err) {
    console.error(err);
    setSaveStatus(`No se ha podido eliminar: ${err.message || err}`, 'error');
  }
}

$('btn-delete').addEventListener('click', () => removeGame(state.currentId));
$('btn-delete-public').addEventListener('click', () => removeGame(state.readingId));

function resetToUpload() {
  state.extraction = null;
  state.currentId = null;
  state.box = null;
  $('results').hidden = true;
  updateSavedBanner();
  updateSaveButtons();
  setStatus('');
}

$('btn-new').addEventListener('click', () => {
  resetToUpload();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function showGame(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game?.extraction) return;
  state.readingId = id;
  const box = computeBoxScore(game.extraction);
  const teams = listTeams(state.games);
  const key = teams.some((t) => t.key === state.teamKey) ? state.teamKey : (teams[0]?.key || '');
  const preferred = box.teams.findIndex((t) => teamKey(t.name) === key);
  state.readTeam = preferred >= 0 ? preferred : 0;
  setView('games');
  $('public-game').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editGame(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game || !canManage(game)) return;
  setExtraction(structuredClone(game.extraction), { savedId: id });
  setView('acta');
  window.scrollTo({ top: 0 });
}

function updateZone() {
  const openPrivate = !!state.user || params.has('demo');
  $('tab-acta').hidden = !openPrivate;
  if (!openPrivate && state.view === 'acta') setView('games');
}

// ---------- Vistas ----------
function setView(view) {
  state.view = view;
  document.querySelectorAll('.view-tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  ['acta', 'games', 'totals'].forEach((v) => { $(`view-${v}`).hidden = v !== view; });
  if (view !== 'acta') renderSaved();
}
document.querySelectorAll('.view-tab').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function setTeam(key) {
  state.teamKey = key;
  localStorage.setItem('acta.team', key);
  const game = readingGame();
  if (game?.extraction) {
    const box = computeBoxScore(game.extraction);
    const preferred = box.teams.findIndex((t) => teamKey(t.name) === key);
    if (preferred >= 0) state.readTeam = preferred;
  }
  renderSaved();
}
document.querySelectorAll('.team-select').forEach((sel) => sel.addEventListener('change', () => setTeam(sel.value)));

async function refreshGames() {
  $('games-status').textContent = 'Cargando partidos…';
  try {
    state.games = await listGames();
    state.gamesLoaded = true;
    $('games-status').textContent = '';
  } catch (err) {
    console.error(err);
    $('games-status').textContent = /permission/i.test(String(err?.code || err?.message))
      ? 'Los partidos no se pueden leer. Publica firestore.rules para abrir la lectura.'
      : `No se han podido cargar los partidos: ${err.message || err}`;
  }
  renderSaved();
  updateSaveButtons();
}

const fmt1 = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '—');

function readingGame() {
  return state.games.find((g) => g.id === state.readingId) || null;
}

function renderPublicDetail() {
  const host = $('public-game');
  const game = readingGame();
  if (!game?.extraction) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  const box = computeBoxScore(game.extraction);
  state.readTeam = Math.max(0, Math.min(state.readTeam, box.teams.length - 1));
  const team = box.teams[state.readTeam];
  $('public-tabs').innerHTML = box.teams.map((t, n) => `
    <button type="button" class="tab ${n === state.readTeam ? 'active' : ''}" data-i="${n}">
      ${esc(t.name || `Equipo ${t.side || n + 1}`)} <span>${t.finalScore}</span>
    </button>`).join('');
  $('public-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    state.readTeam = +b.dataset.i;
    renderPublicDetail();
  }));
  $('public-name').textContent = team?.name || 'Equipo';
  $('public-sub').textContent = gameSubtitle(box, state.readTeam);
  $('public-score').textContent = scoreLine(box, state.readTeam);
  $('public-table').innerHTML = boxTableHtml(box, state.readTeam);
  const manage = canManage(game);
  $('btn-edit-game').hidden = !manage;
  $('btn-delete-public').hidden = !manage;
}

$('btn-close-game').addEventListener('click', () => {
  state.readingId = null;
  renderPublicDetail();
});
$('btn-edit-game').addEventListener('click', () => editGame(state.readingId));
$('btn-public-jpg').addEventListener('click', () => {
  const game = readingGame();
  if (game?.extraction) downloadJpg(computeBoxScore(game.extraction), state.readTeam);
});
$('btn-public-csv').addEventListener('click', () => {
  const game = readingGame();
  if (game?.extraction) downloadCsv(computeBoxScore(game.extraction), state.readTeam);
});

function renderSaved() {
  $('games-count').textContent = state.games.length ? String(state.games.length) : '';
  const teams = listTeams(state.games);
  const key = teams.some((t) => t.key === state.teamKey) ? state.teamKey : (teams[0]?.key || '');
  if (key) state.teamKey = key;
  document.querySelectorAll('.team-select').forEach((sel) => {
    sel.innerHTML = teams.length
      ? teams.map((t) => `<option value="${esc(t.key)}" ${t.key === key ? 'selected' : ''}>${esc(t.name)} (${t.games})</option>`).join('')
      : '<option value="">—</option>';
    sel.disabled = !teams.length;
  });

  if (!state.games.length) {
    const msg = state.gamesLoaded
      ? (state.user
        ? '<p class="muted">Todavía no hay partidos guardados. En «Acta» puedes analizar una y guardarla.</p>'
        : '<p class="muted">Todavía no hay partidos guardados.</p>')
      : '';
    $('games-list').innerHTML = msg;
    $('totals-summary').innerHTML = '';
    $('totals-games').innerHTML = '';
    $('totals-players').innerHTML = msg;
    renderPublicDetail();
    return;
  }

  const agg = aggregateTeam(state.games, key);
  renderGamesList(agg);
  renderTotals(aggregateTeam(state.games, findEannaKey(state.games)));
  renderPublicDetail();
}

function resultBadge(m) {
  if (m.pointsAgainst === null) return '';
  if (m.pointsFor > m.pointsAgainst) return '<span class="result w">G</span>';
  if (m.pointsFor < m.pointsAgainst) return '<span class="result l">P</span>';
  return '<span class="result">E</span>';
}

function renderGamesList(agg) {
  const manageable = state.games.some((g) => canManage(g));
  const rows = [...agg.matches].reverse().map((m) => {
    const top = m.team.hasScoring ? m.team.rows[0] : null;
    const game = state.games.find((g) => g.id === m.id);
    const actions = canManage(game)
      ? `<td class="row-actions"><button type="button" class="btn ghost small" data-edit="${esc(m.id)}">Editar</button><button type="button" class="btn danger small" data-del="${esc(m.id)}">Eliminar</button></td>`
      : (manageable ? '<td></td>' : '');
    return `
      <tr class="clickable" data-id="${esc(m.id)}">
        <td>${esc(m.dateLabel || '—')}</td>
        <td>${esc(m.opponent || '—')}</td>
        <td>${resultBadge(m)} <b>${m.pointsFor}</b> – ${m.pointsAgainst ?? '—'}</td>
        <td>${esc(m.competition)}</td>
        <td>${top ? `${esc(playerLabel(top))} (${top.pts})` : '<span class="muted">solo resultado</span>'}</td>
        ${actions}
      </tr>`;
  }).join('');
  const actionHead = manageable ? '<th></th>' : '';
  $('games-list').innerHTML = `
    <table class="list">
      <thead><tr><th>Fecha</th><th>Rival</th><th>Resultado</th><th>Competición</th><th>Máximo anotador</th>${actionHead}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('games-list').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => showGame(tr.dataset.id)));
  $('games-list').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    editGame(b.dataset.edit);
  }));
  $('games-list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    removeGame(b.dataset.del);
  }));
}

function againstStat(label, stat, n) {
  const scope = stat.games && stat.games < n ? ` · ${stat.games} de ${n}` : '';
  return [`${label}${scope}`, stat.games ? String(stat.total) : '—'];
}

function cellNum(v) {
  return v === null || v === undefined ? '—' : v;
}

function sumKnown(values) {
  const known = values.filter((v) => Number.isFinite(v));
  return known.length ? known.reduce((a, v) => a + v, 0) : null;
}

function pairCells(favor, against, cls = '') {
  return `<td class="${cls}">${cellNum(favor)}</td><td class="opp ${cls}">${cellNum(against)}</td>`;
}

function renderGamesTable(agg) {
  const q = (list, i) => (list ? list[i] : null);
  const rows = agg.matches.map((m) => `
    <tr>
      <td>${esc(m.dateLabel || '—')}</td>
      <td class="name">${esc(m.opponent || '—')}</td>
      ${pairCells(m.pointsFor, m.pointsAgainst, 'pts')}
      ${pairCells(m.foulsFor, m.against?.fouls)}
      ${[0, 1, 2, 3].map((i) => pairCells(q(m.quartersFor, i), q(m.against?.quarters, i))).join('')}
    </tr>`).join('');
  const quartersFor = [0, 1, 2, 3].map((i) => sumKnown(agg.matches.map((m) => q(m.quartersFor, i))));
  const quartersAgainst = [0, 1, 2, 3].map((i) => sumKnown(agg.matches.map((m) => q(m.against?.quarters, i))));
  const sub = ['A favor', 'En contra', 'A favor', 'En contra', 'A favor', 'En contra', 'A favor', 'En contra', 'A favor', 'En contra', 'A favor', 'En contra']
    .map((label, i) => `<th class="${i % 2 ? 'opp' : ''}">${label}</th>`).join('');
  $('totals-games').innerHTML = `
    <h3>Por partido</h3>
    <table class="box">
      <thead>
        <tr>
          <th class="left" rowspan="2">Fecha</th>
          <th class="left" rowspan="2">Rival</th>
          <th colspan="2">Puntos</th>
          <th colspan="2">Faltas</th>
          <th colspan="2">Q1</th>
          <th colspan="2">Q2</th>
          <th colspan="2">Q3</th>
          <th colspan="2">Q4</th>
        </tr>
        <tr>${sub}</tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot><tr>
        <td></td><td>TOTAL</td>
        ${pairCells(sumKnown(agg.matches.map((m) => m.pointsFor)), sumKnown(agg.matches.map((m) => m.pointsAgainst)))}
        ${pairCells(sumKnown(agg.matches.map((m) => m.foulsFor)), sumKnown(agg.matches.map((m) => m.against?.fouls)))}
        ${[0, 1, 2, 3].map((i) => pairCells(quartersFor[i], quartersAgainst[i])).join('')}
      </tr></tfoot>
    </table>`;
}

function favorShot(label, stat, each, n) {
  const scope = stat.games && stat.games < n ? ` · ${stat.games} de ${n}` : '';
  const pts = stat.games ? ` · ${stat.total * each} pts` : '';
  return [`${label}${pts}${scope}`, stat.games ? String(stat.total) : '—'];
}

function renderTotals(agg) {
  const n = agg.matches.length;
  const stats = [
    ['Partidos', n],
    ['Balance', `${agg.record.w}-${agg.record.l}`],
    ['Puntos a favor / partido', fmt1(n ? agg.pointsFor / n : NaN)],
    favorShot('Tiros de 2 a favor', agg.favor.fg2, 2, n),
    favorShot('Tiros de 3 a favor', agg.favor.fg3, 3, n),
    favorShot('Tiros de 1 a favor', agg.favor.ftm, 1, n),
    ['Puntos en contra / partido', fmt1(n ? agg.pointsAgainst / n : NaN)],
    againstStat('Tiros de 2 en contra', agg.against.fg2, n),
    againstStat('Tiros de 3 en contra', agg.against.fg3, n),
    againstStat('Tiros de 1 en contra', agg.against.ftm, n),
    againstStat('Faltas en contra', agg.against.fouls, n),
    ['Con estadísticas', `${agg.gamesWithStats} de ${n}`],
  ];
  $('totals-summary').innerHTML = stats.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');
  renderGamesTable(agg);

  if (!agg.rows.length) {
    $('totals-players').innerHTML = '<p class="muted">Ningún partido tiene marcador por jugador.</p>';
    return;
  }
  const cls = (v) => (v === 0 ? 'zero' : '');
  const body = agg.rows.map((r) => {
    const gp = r.gp;
    const per = (v) => (gp ? fmt1(v / gp) : '—');
    return `
      <tr class="${r.onRoster ? '' : 'off'}">
        <td><span class="chip">${esc(r.number)}</span></td>
        <td class="name">${esc(playerLabel(r))}</td>
        <td>${gp}</td>
        <td class="${cls(r.fouls)}">${r.fouls}</td>
        <td class="avg">${per(r.fouls)}</td>
        <td class="pts ${cls(r.pts)}">${r.pts}</td>
        <td class="avg">${per(r.pts)}</td>
        ${[0, 1, 2, 3].map((q) => `<td class="${cls(r.quarters[q])}">${r.quarters[q]}</td>`).join('')}
      </tr>`;
  }).join('');
  const t = agg.rows.reduce((a, r) => {
    a.pts += r.pts;
    a.fouls += r.fouls;
    for (let q = 0; q < 4; q++) a.quarters[q] += r.quarters[q] || 0;
    return a;
  }, { pts: 0, fouls: 0, quarters: [0, 0, 0, 0] });
  const g = agg.gamesWithStats;
  $('totals-players').innerHTML = `
    <h3>Por jugador</h3>
    <table class="box">
      <thead><tr>
        <th class="left">#</th><th class="left">Jugador</th><th>PJ</th>
        <th>Faltas</th><th class="avg">F/PJ</th>
        <th>PTS</th><th class="avg">PTS/PJ</th>
        <th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td></td><td>TOTAL (${g} ${g === 1 ? 'partido' : 'partidos'})</td><td>${g}</td>
        <td>${t.fouls}</td><td>${g ? fmt1(t.fouls / g) : '—'}</td>
        <td>${t.pts}</td><td>${g ? fmt1(t.pts / g) : '—'}</td>
        ${t.quarters.map((q) => `<td>${q}</td>`).join('')}
      </tr></tfoot>
    </table>`;
}

updateAnalyzeButton();
updateSaveButtons();
if (params.has('demo')) {
  $('tab-acta').hidden = false;
  setView('acta');
  loadDemo();
} else {
  renderSaved();
}
