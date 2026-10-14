// Lista de Éanna: el dorsal no cambia de partido. La primera acta con nombres
// es la lista; el resto de partidos muestran esos nombres y se contrastan con ella.

import { isEannaName, parseGameDate, teamKey } from './boxscore.js';

export function jerseyKey(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim().replace(/^#/, '');
  if (!s) return '';
  if (/^0+$/.test(s)) return s.length > 1 ? '00' : '0';
  return s.replace(/^0+(?=\d)/, '');
}

export function sameName(a, b) {
  const left = teamKey(a);
  const right = teamKey(b);
  return !!left && left === right;
}

function eannaTeam(extraction) {
  return (extraction?.teams || []).find((t) => isEannaName(t.name)) || null;
}

function listed(players) {
  const seen = new Set();
  const out = [];
  for (const p of players || []) {
    const number = jerseyKey(p.number);
    const name = String(p.name || '').trim();
    if (!number || !name || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, name });
  }
  return out;
}

function createdStamp(game) {
  const t = game?.createdAt;
  if (t && typeof t.toMillis === 'function') return String(t.toMillis()).padStart(16, '0');
  if (t && typeof t.seconds === 'number') {
    const ms = t.seconds * 1000 + Math.floor((t.nanoseconds || 0) / 1e6);
    return String(ms).padStart(16, '0');
  }
  return '9999999999999999';
}

function byWhen(a, b) {
  const byDate = (a.date || '9999').localeCompare(b.date || '9999');
  if (byDate) return byDate;
  const byCreated = a.created.localeCompare(b.created);
  if (byCreated) return byCreated;
  return String(a.id).localeCompare(String(b.id));
}

/** La primera acta de Éanna que tiene dorsales con nombre. */
export function rosterFromGames(games) {
  const rows = [];
  for (const g of games || []) {
    const players = listed(eannaTeam(g.extraction)?.players);
    if (!players.length) continue;
    rows.push({
      id: g.id || '',
      date: parseGameDate(g.extraction?.game?.date),
      dateLabel: String(g.extraction?.game?.date || '').trim(),
      created: createdStamp(g),
      players,
    });
  }
  rows.sort(byWhen);
  return rows[0] || null;
}

/**
 * El acta abierto es la lista si no hay otra anterior.
 * Manda la fecha del partido; si empatan, el acta que se guardó antes.
 * Un acta aún sin guardar no adelanta a uno guardado de la misma fecha.
 */
export function rosterContext(games, extraction, currentId = null) {
  const others = (games || []).filter((g) => !currentId || g.id !== currentId);
  const saved = rosterFromGames(others);
  const own = eannaTeam(extraction);
  const ownDate = parseGameDate(extraction?.game?.date);
  const current = (games || []).find((g) => currentId && g.id === currentId);
  const ownCreated = currentId ? createdStamp(current) : '9999999999999999';
  const ownKey = `${ownDate || '9999'}|${ownCreated}|${currentId || '\uffff'}`;
  const savedKey = saved ? `${saved.date || '9999'}|${saved.created}|${saved.id}` : null;
  const source = !!own && (!saved || ownKey < savedKey);
  if (source) {
    return {
      source: true,
      hasEanna: true,
      id: currentId || null,
      date: ownDate,
      dateLabel: String(extraction?.game?.date || '').trim(),
      players: listed(own.players),
    };
  }
  return {
    source: false,
    hasEanna: !!own,
    id: saved?.id || null,
    date: saved?.date || '',
    dateLabel: saved?.dateLabel || '',
    players: (saved?.players || []).map((p) => ({ ...p })),
  };
}

/** Copia el acta y pone en Éanna el nombre de la lista cuando el dorsal coincide. */
export function applyRoster(extraction, roster) {
  if (!extraction || !roster?.players?.length) return extraction;
  const copy = structuredClone(extraction);
  const team = eannaTeam(copy);
  if (!team?.players) return copy;
  const names = new Map(roster.players.map((p) => [jerseyKey(p.number), String(p.name || '').trim()]));
  for (const p of team.players) {
    const num = jerseyKey(p.number);
    const name = num ? names.get(num) : '';
    if (name) p.name = name;
  }
  return copy;
}

/** Correcciones de la columna «nombre de la lista» todavía sin guardar. */
export function withListEdits(roster, edits) {
  const players = (roster?.players || [])
    .map((p) => ({ number: jerseyKey(p.number), name: String(p.name || '').trim() }))
    .filter((p) => p.number && p.name);
  const byNum = new Map(players.map((p) => [p.number, p]));
  const entries = edits instanceof Map ? [...edits.entries()] : Object.entries(edits || {});
  for (const [raw, rawName] of entries) {
    const number = jerseyKey(raw);
    const name = String(rawName || '').trim();
    if (!number || !name) continue;
    const row = byNum.get(number);
    if (row) row.name = name;
    else {
      const added = { number, name };
      players.push(added);
      byNum.set(number, added);
    }
  }
  return { ...(roster || {}), players };
}

export function rosterRows(players, list) {
  const canonical = new Map();
  for (const p of list || []) {
    const number = jerseyKey(p.number);
    const name = String(p.name || '').trim();
    if (number && name && !canonical.has(number)) canonical.set(number, name);
  }
  const comparing = canonical.size > 0;
  const seen = new Set();
  return (players || []).map((p) => {
    const number = jerseyKey(p.number);
    const name = String(p.name || '').trim();
    const doubts = [];
    let repeated = false;
    if (!number) doubts.push('No jersey number.');
    else if (seen.has(number)) {
      repeated = true;
      doubts.push(`Jersey ${number} is repeated on this scoresheet.`);
    } else seen.add(number);
    const onList = !!(number && canonical.has(number));
    const listName = onList ? canonical.get(number) : '';
    if (comparing && number && !onList && !repeated) doubts.push(`Jersey ${number} is not on the player list.`);
    if (onList && !name) doubts.push(`Name not read; the list says “${listName}”.`);
    else if (onList && !sameName(name, listName)) doubts.push(`Read as “${name}”; the list says “${listName}”.`);
    return {
      number,
      name,
      listName,
      onList,
      doubts,
      jerseyDoubt: !number || repeated || (comparing && number && !onList),
      nameDoubt: onList && (!name || !sameName(name, listName)),
    };
  });
}

/** Jugadores de la lista que no están en este acta. No es un error: pueden no haber jugado. */
export function absentFromSheet(players, list) {
  const present = new Set((players || []).map((p) => jerseyKey(p.number)).filter(Boolean));
  return (list || []).filter((p) => {
    const number = jerseyKey(p.number);
    return number && p.name && !present.has(number);
  });
}
