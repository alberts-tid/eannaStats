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
  computeBoxScore, aggregateTeam, listTeams, teamKey, QUARTER_LABELS,
} from './boxscore.js';
import { initStore, listGames, saveGame, deleteGame } from './store.js';
import { EXTRACTION_PROMPT, buildResponseSchema } from './prompt.js';
import { renderBoxScoreCanvas, playerLabel, defaultNotes } from './render.js';
import { firebaseConfig, appCheckSiteKey } from './firebase-config.js';

const DEFAULT_MODEL = 'gemini-3.7-flash';
const MAX_SIDE = 3072;

const params = new URLSearchParams(location.search);
// ?emulator usa los emuladores locales de Firebase (Auth 9099, Firestore 8080) para pruebas.
const emulatorHost = params.has('emulator') ? (params.get('emulator') || '127.0.0.1') : null;

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
if (emulatorHost) connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
initStore(app, { emulatorHost });
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
  view: 'acta',
};

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
  state.games = [];
  state.gamesLoaded = false;
  if (user) refreshGames();
  else renderSaved();
  updateSaveButtons();
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
  $('analyze-hint').textContent = !state.user
    ? 'Inicia sesión para analizar con IA.'
    : (!state.image ? 'Sube primero una foto del acta.' : '');
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
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  URL.revokeObjectURL(url);
  state.image = { base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', name: file.name };
  $('preview').src = dataUrl;
  $('preview-wrap').hidden = false;
  $('drop-label').textContent = file.name;
  setStatus('');
  updateAnalyzeButton();
}

$('file').addEventListener('change', (ev) => loadImage(ev.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (ev) => loadImage(ev.dataTransfer.files[0]));

// ---------- AI ----------
$('model').value = localStorage.getItem('acta.model') || DEFAULT_MODEL;
$('model').addEventListener('change', () => localStorage.setItem('acta.model', $('model').value.trim()));

async function analyze() {
  const modelName = $('model').value.trim() || DEFAULT_MODEL;
  const model = getGenerativeModel(ai, {
    model: modelName,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: buildResponseSchema(Schema),
      temperature: 0,
      thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
    },
  }, { timeout: 300000 });
  const extra = $('hint').value.trim();
  const prompt = extra ? `${EXTRACTION_PROMPT}\n\nExtra context from the user: ${extra}` : EXTRACTION_PROMPT;
  const parts = [prompt, { inlineData: { data: state.image.base64, mimeType: state.image.mimeType } }];
  const delays = [3000, 8000, 15000];
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await model.generateContent(parts);
      return JSON.parse(result.response.text());
    } catch (err) {
      if (attempt >= delays.length || !isTransient(err)) throw err;
      setStatus(`Gemini está saturado; reintentando (${attempt + 1}/${delays.length})…`, 'info');
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

$('btn-analyze').addEventListener('click', async () => {
  const btn = $('btn-analyze');
  btn.disabled = true;
  setStatus('Analizando el acta con IA… puede tardar entre 20 segundos y un par de minutos.', 'info');
  try {
    const extraction = await analyze();
    setExtraction(extraction);
    setStatus('Acta analizada. Revisa los avisos y corrige dorsales si hace falta.', 'ok');
  } catch (err) {
    console.error(err);
    setStatus(describeError(err), 'error');
  } finally {
    updateAnalyzeButton();
  }
});

function isTransient(err) {
  return /\[(500|503|429)\b|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(String(err?.message || err));
}

function describeError(err) {
  const msg = String(err?.message || err);
  const code = String(err?.code || '');
  const detail = ` (Detalle: ${msg})`;
  if (/api-not-enabled/.test(code) || /SERVICE_DISABLED|has not been used/i.test(msg)) {
    return `Firebase AI Logic no está activado en el proyecto. Actívalo en Firebase Console → AI Logic → Get started (Gemini Developer API).${detail}`;
  }
  if (/App Check|appCheck|app-check/i.test(msg + code)) {
    return appCheckSiteKey
      ? `App Check ha rechazado la petición. En localhost registra el token de depuración que aparece en la consola del navegador (F12) en Firebase Console → App Check → Administrar tokens de depuración.${detail}`
      : `AI Logic exige App Check y esta web no lo tiene configurado.${detail}`;
  }
  if (/not found|404/i.test(msg)) return `El modelo «${$('model').value.trim() || DEFAULT_MODEL}» no está disponible. Prueba otro en «Opciones».${detail}`;
  if (/high demand|overloaded|UNAVAILABLE|\[50[03]/i.test(msg)) return `Gemini está saturado ahora mismo. Espera un minuto y vuelve a intentarlo, o prueba otro modelo en «Opciones».${detail}`;
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(msg)) return `Se ha superado la cuota de Gemini; espera un poco y vuelve a intentarlo.${detail}`;
  if (/JSON/i.test(msg)) return `La IA ha devuelto una respuesta que no es JSON válido. Vuelve a intentarlo.${detail}`;
  return `Error al analizar: ${msg}`;
}

$('btn-demo').addEventListener('click', async () => {
  const res = await fetch('fixtures/eanna-drogheda.json');
  setExtraction(await res.json());
  setStatus('Ejemplo cargado (Éanna BC vs Drogheda Wolves), sin llamar a la IA.', 'ok');
});

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
  $('json').value = JSON.stringify(extraction, null, 2);
  recompute();
}

function recompute() {
  state.box = computeBoxScore(state.extraction);
  renderResults();
}

function gameSubtitle(box) {
  const g = box.game || {};
  const other = box.teams.find((_, i) => i !== state.teamIndex);
  return [g.competition, g.venue, other?.name ? `vs ${other.name}` : '', g.date]
    .filter(Boolean).join(' · ');
}

function scoreLine(box) {
  const t = box.teams[state.teamIndex];
  const other = box.teams.find((_, i) => i !== state.teamIndex);
  if (!t) return '';
  return other ? `${t.finalScore} – ${other.finalScore}` : String(t.finalScore);
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

  if (!team.hasScoring) {
    $('table-wrap').innerHTML = '<p class="muted">No se ha leído ninguna anotación de este equipo en el marcador.</p>';
  } else {
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
    const foot = `<tr><td></td><td>TOTAL</td>${[t.pts, t.fg2, t.fg3, t.ftm, t.fouls, ...t.quarters].map((v) => `<td>${v}</td>`).join('')}</tr>`;
    $('table-wrap').innerHTML = `
      <table class="box">
        <thead><tr>${head.map((h, i) => `<th class="${i < 2 ? 'left' : ''}">${h}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
        <tfoot>${foot}</tfoot>
      </table>
      <ul class="notes">${defaultNotes(team).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
  }

  const warnings = [...team.warnings, ...(state.extraction.notes || []).map((n) => `IA: ${n}`)];
  $('warnings').hidden = !warnings.length;
  $('warnings-list').innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');

  renderEditor();
}

function renderEditor() {
  const team = state.extraction.teams?.[state.teamIndex];
  const plays = new Map(state.box.teams[state.teamIndex].plays.map((p) => [p.idx, p]));
  const rows = (team?.scoring || []).map((e, idx) => ({ e, idx, play: plays.get(idx) }))
    .sort((a, b) => (+a.e.total || 0) - (+b.e.total || 0));
  $('editor').innerHTML = rows.map(({ e, idx, play }) => `
    <div class="ev ${play && play.kind === 'OTHER' ? 'bad' : ''}" data-idx="${idx}">
      <input type="number" class="ev-total" value="${esc(e.total)}" min="1" title="Marcador">
      <input type="text" class="ev-jersey" value="${esc(e.jersey)}" title="Dorsal">
      <label title="Dorsal rodeado (triple)"><input type="checkbox" class="ev-three" ${e.threePointer ? 'checked' : ''}>T3</label>
      <span class="ev-kind">${play ? `${play.kind === 'OTHER' ? `+${play.points}?` : play.kind} ${QUARTER_LABELS[play.quarter] || ''}` : '—'}</span>
      <button type="button" class="ev-del" title="Eliminar">×</button>
    </div>`).join('') || '<p class="muted">Sin anotaciones.</p>';

  $('editor').querySelectorAll('.ev').forEach((row) => {
    const entry = team.scoring[+row.dataset.idx];
    row.querySelector('.ev-total').addEventListener('change', (ev) => { entry.total = parseInt(ev.target.value, 10); syncJson(); });
    row.querySelector('.ev-jersey').addEventListener('change', (ev) => { entry.jersey = ev.target.value.trim(); syncJson(); });
    row.querySelector('.ev-three').addEventListener('change', (ev) => { entry.threePointer = ev.target.checked; syncJson(); });
    row.querySelector('.ev-del').addEventListener('click', () => { team.scoring.splice(+row.dataset.idx, 1); syncJson(); });
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

$('btn-jpg').addEventListener('click', async () => {
  await document.fonts.ready;
  const box = state.box;
  const team = box.teams[state.teamIndex];
  const canvas = renderBoxScoreCanvas(team, {
    title: team.name,
    subtitle: gameSubtitle(box),
    score: scoreLine(box),
    badge: 'FINAL',
  });
  canvas.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(team.name)}-box-score.jpg`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/jpeg', 0.93);
});

$('btn-csv').addEventListener('click', () => {
  const team = state.box.teams[state.teamIndex];
  const header = ['Number', 'Player', 'PTS', '2PM', '3PM', 'FTM', 'Fouls', ...QUARTER_LABELS];
  const lines = [header, ...team.rows.map((r) => [r.number, playerLabel(r), r.pts, r.fg2, r.fg3, r.ftm, r.fouls ?? '', ...r.quarters])];
  const t = team.totals;
  lines.push(['', 'TOTAL', t.pts, t.fg2, t.fg3, t.ftm, t.fouls, ...t.quarters]);
  const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${slugify(team.name)}-box-score.csv`;
  a.click();
});

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
  const canDelete = state.user && game && (game.createdBy === state.user.uid || state.user.email === 'albertsinfreu@gmail.com');
  $('btn-delete').hidden = !canDelete;
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

$('btn-delete').addEventListener('click', async () => {
  if (!state.currentId || !confirm('¿Eliminar este partido guardado? Dejará de contar en el acumulado.')) return;
  try {
    await deleteGame(state.currentId);
    resetToUpload();
    await refreshGames();
    setView('games');
  } catch (err) {
    console.error(err);
    setSaveStatus(`No se ha podido eliminar: ${err.message || err}`, 'error');
  }
});

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

function openGame(id) {
  const game = state.games.find((g) => g.id === id);
  if (!game) return;
  setExtraction(structuredClone(game.extraction), { savedId: id });
  setView('acta');
  window.scrollTo({ top: 0 });
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
  renderSaved();
}
document.querySelectorAll('.team-select').forEach((sel) => sel.addEventListener('change', () => setTeam(sel.value)));

async function refreshGames() {
  if (!state.user) return;
  $('games-status').textContent = 'Cargando partidos…';
  try {
    state.games = await listGames();
    state.gamesLoaded = true;
    $('games-status').textContent = '';
  } catch (err) {
    console.error(err);
    $('games-status').textContent = /permission/i.test(String(err?.code || err?.message))
      ? 'Firestore ha denegado la lectura. ¿Están desplegadas las reglas de acta_partits?'
      : `No se han podido cargar los partidos: ${err.message || err}`;
  }
  renderSaved();
  updateSaveButtons();
}

const fmt1 = (v) => (Number.isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : '—');

function renderSaved() {
  $('games-count').textContent = state.games.length ? String(state.games.length) : '';
  const teams = listTeams(state.games);
  const key = teams.some((t) => t.key === state.teamKey) ? state.teamKey : (teams[0]?.key || '');
  document.querySelectorAll('.team-select').forEach((sel) => {
    sel.innerHTML = teams.length
      ? teams.map((t) => `<option value="${esc(t.key)}" ${t.key === key ? 'selected' : ''}>${esc(t.name)} (${t.games})</option>`).join('')
      : '<option value="">—</option>';
    sel.disabled = !teams.length;
  });

  if (!state.user) {
    const msg = '<p class="muted">Inicia sesión para ver los partidos guardados.</p>';
    $('games-list').innerHTML = msg;
    $('totals-summary').innerHTML = '';
    $('totals-table').innerHTML = msg;
    $('totals-matrix').innerHTML = '';
    return;
  }
  if (!state.games.length) {
    const msg = state.gamesLoaded ? '<p class="muted">Todavía no hay partidos guardados. Analiza un acta y pulsa «Guardar partido».</p>' : '';
    $('games-list').innerHTML = msg;
    $('totals-summary').innerHTML = '';
    $('totals-table').innerHTML = msg;
    $('totals-matrix').innerHTML = '';
    return;
  }

  const agg = aggregateTeam(state.games, key);
  renderGamesList(agg);
  renderTotals(agg);
}

function resultBadge(m) {
  if (m.pointsAgainst === null) return '';
  if (m.pointsFor > m.pointsAgainst) return '<span class="result w">G</span>';
  if (m.pointsFor < m.pointsAgainst) return '<span class="result l">P</span>';
  return '<span class="result">E</span>';
}

function renderGamesList(agg) {
  const rows = [...agg.matches].reverse().map((m) => {
    const top = m.team.hasScoring ? m.team.rows[0] : null;
    return `
      <tr class="clickable" data-id="${esc(m.id)}">
        <td>${esc(m.dateLabel || '—')}</td>
        <td>${esc(m.opponent || '—')}</td>
        <td>${resultBadge(m)} <b>${m.pointsFor}</b> – ${m.pointsAgainst ?? '—'}</td>
        <td>${esc(m.competition)}</td>
        <td>${top ? `${esc(playerLabel(top))} (${top.pts})` : '<span class="muted">solo resultado</span>'}</td>
      </tr>`;
  }).join('');
  $('games-list').innerHTML = `
    <table class="list">
      <thead><tr><th>Fecha</th><th>Rival</th><th>Resultado</th><th>Competición</th><th>Máximo anotador</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('games-list').querySelectorAll('tr[data-id]').forEach((tr) => tr.addEventListener('click', () => openGame(tr.dataset.id)));
}

function renderTotals(agg) {
  const n = agg.matches.length;
  const stats = [
    ['Partidos', n],
    ['Balance', `${agg.record.w}-${agg.record.l}`],
    ['Puntos a favor / partido', fmt1(n ? agg.pointsFor / n : NaN)],
    ['Puntos en contra / partido', fmt1(n ? agg.pointsAgainst / n : NaN)],
    ['Con estadísticas', `${agg.gamesWithStats} de ${n}`],
  ];
  $('totals-summary').innerHTML = stats.map(([k, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('');

  if (!agg.rows.length) {
    $('totals-table').innerHTML = '<p class="muted">Ningún partido de este equipo tiene marcador por jugador.</p>';
    $('totals-matrix').innerHTML = '';
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
        <td class="pts ${cls(r.pts)}">${r.pts}</td>
        <td class="avg">${per(r.pts)}</td>
        <td class="${cls(r.fg2)}">${r.fg2}</td>
        <td class="${cls(r.fg3)}">${r.fg3}</td>
        <td class="${cls(r.ftm)}">${r.ftm}</td>
        <td class="${cls(r.fouls)}">${r.fouls}</td>
        <td class="avg">${per(r.fouls)}</td>
      </tr>`;
  }).join('');
  const t = agg.rows.reduce((a, r) => ({
    pts: a.pts + r.pts, fg2: a.fg2 + r.fg2, fg3: a.fg3 + r.fg3, ftm: a.ftm + r.ftm, fouls: a.fouls + r.fouls,
  }), { pts: 0, fg2: 0, fg3: 0, ftm: 0, fouls: 0 });
  const g = agg.gamesWithStats;
  $('totals-table').innerHTML = `
    <table class="box">
      <thead><tr><th class="left">#</th><th class="left">Player</th><th>PJ</th><th>PTS</th><th class="avg">PTS/PJ</th><th>2PM</th><th>3PM</th><th>FTM</th><th>Fouls</th><th class="avg">F/PJ</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td></td><td>TOTAL (${g} ${g === 1 ? 'partido' : 'partidos'})</td><td>${g}</td><td>${t.pts}</td><td>${g ? fmt1(t.pts / g) : '—'}</td><td>${t.fg2}</td><td>${t.fg3}</td><td>${t.ftm}</td><td>${t.fouls}</td><td>${g ? fmt1(t.fouls / g) : '—'}</td></tr></tfoot>
    </table>`;

  const cols = agg.matches.map((m, i) => ({ m, i })).filter(({ m }) => m.team.hasScoring);
  const head = cols.map(({ m }) => `<th class="game">${esc(m.dateLabel || '—')}<br>${esc(m.opponent ? `vs ${m.opponent}` : '')}</th>`).join('');
  const mrows = agg.rows.map((r) => `
    <tr class="${r.onRoster ? '' : 'off'}">
      <td class="name"><span class="chip">${esc(r.number)}</span> ${esc(playerLabel(r))}</td>
      ${cols.map(({ i }) => {
        const v = r.perGame[i];
        return `<td class="${v === 0 ? 'zero' : ''}">${v === null ? '<span class="muted">·</span>' : v}</td>`;
      }).join('')}
    </tr>`).join('');
  $('totals-matrix').innerHTML = `
    <table class="box matrix">
      <thead><tr><th class="left">Player</th>${head}</tr></thead>
      <tbody>${mrows}</tbody>
    </table>
    <p class="muted small">«·» = no jugó ese partido.</p>`;
}

if (params.has('demo')) $('btn-demo').click();
updateAnalyzeButton();
updateSaveButtons();
renderSaved();
