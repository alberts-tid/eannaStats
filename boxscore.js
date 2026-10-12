// Cálculo puro (sin DOM ni Firebase): a partir de la lectura del acta hecha por la IA
// reconstruye el box score de cada equipo. Funciona en el navegador y en Node.

export const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4'];

function normJersey(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim().replace(/^#/, '');
  if (/^0+$/.test(s)) return s.length > 1 ? '00' : '0';
  return s.replace(/^0+(?=\d)/, '');
}

function quarterOf(total, quarterEnds) {
  for (let i = 0; i < quarterEnds.length; i++) {
    if (total <= quarterEnds[i]) return i;
  }
  return Math.max(0, quarterEnds.length - 1);
}

function emptyLine(number, name, onRoster) {
  return {
    number,
    name,
    onRoster,
    pts: 0,
    fg2: 0,
    fg3: 0,
    ftm: 0,
    other: 0,
    fouls: onRoster ? 0 : null,
    played: null,
    quarters: [0, 0, 0, 0],
  };
}

/**
 * team: {
 *   name, players: [{number, name, fouls}],
 *   scoring: [{total, jersey, threePointer?, freeThrow?}],
 *   quarterEndTotals: [36, 64, 86, 114], quarterScores: [36, 28, 22, 28], finalScore
 * }
 */
export function computeTeamBoxScore(team) {
  const warnings = [];
  const players = Array.isArray(team.players) ? team.players : [];
  const lines = new Map();
  for (const p of players) {
    const num = normJersey(p.number);
    if (!num || lines.has(num)) continue;
    const line = emptyLine(num, (p.name || '').trim(), true);
    line.fouls = Number.isFinite(+p.fouls) ? Math.max(0, Math.min(5, +p.fouls)) : 0;
    if (typeof p.played === 'boolean') line.played = p.played;
    lines.set(num, line);
  }

  const events = (Array.isArray(team.scoring) ? team.scoring : [])
    .map((e, idx) => ({ ...e, idx, total: parseInt(e.total, 10), jersey: normJersey(e.jersey) }))
    .filter((e) => Number.isFinite(e.total) && e.total > 0)
    .sort((a, b) => a.total - b.total);

  const quarterEnds = deriveQuarterEnds(team, events, warnings);
  const quarterTotals = [0, 0, 0, 0];
  const plays = [];
  let prev = 0;
  for (const e of events) {
    const diff = e.total - prev;
    if (diff <= 0) {
      warnings.push(`El marcador ${e.total} está repetido o fuera de orden; se ignora.`);
      continue;
    }
    prev = e.total;
    const q = quarterOf(e.total, quarterEnds);
    let kind;
    if (diff === 1) kind = 'FT';
    else if (diff === 2) kind = '2PT';
    else if (diff === 3) kind = '3PT';
    else kind = 'OTHER';

    if (kind === 'OTHER') {
      warnings.push(`Salto de +${diff} hasta ${e.total} (dorsal ${e.jersey || '?'}): falta alguna anotación o hay un número mal leído.`);
    }
    if (kind === '3PT' && e.threePointer === false) {
      warnings.push(`El marcador ${e.total} sube +3 pero el dorsal no aparece rodeado como triple.`);
    }
    if (kind !== '3PT' && e.threePointer === true) {
      warnings.push(`El marcador ${e.total} tiene el dorsal rodeado (triple) pero sube +${diff}.`);
    }
    if (kind === 'FT' && e.freeThrow === false) {
      warnings.push(`El marcador ${e.total} sube +1 pero no está marcado como tiro libre.`);
    }

    let jersey = e.jersey;
    if (!jersey) {
      warnings.push(`El marcador ${e.total} no tiene dorsal legible.`);
      jersey = '?';
    }
    if (!lines.has(jersey)) {
      lines.set(jersey, emptyLine(jersey, '', false));
    }
    const line = lines.get(jersey);
    line.pts += diff;
    line.quarters[q] += diff;
    if (kind === 'FT') line.ftm += 1;
    else if (kind === '2PT') line.fg2 += 1;
    else if (kind === '3PT') line.fg3 += 1;
    else line.other += diff;
    quarterTotals[q] += diff;
    plays.push({ idx: e.idx, total: e.total, jersey, points: diff, kind, quarter: q });
  }

  for (const line of lines.values()) {
    if (!line.onRoster && line.pts > 0) {
      warnings.push(`El dorsal ${line.number} anota ${line.pts} puntos pero no figura en la lista de jugadores.`);
    }
  }

  const finalScore = Number.isFinite(+team.finalScore) && +team.finalScore > 0 ? +team.finalScore : null;
  const computedTotal = prev;
  if (plays.length && finalScore !== null && finalScore !== computedTotal) {
    warnings.push(`La suma del marcador corrido da ${computedTotal}, pero el resultado final leído es ${finalScore}.`);
  }
  const reportedQ = Array.isArray(team.quarterScores) ? team.quarterScores.map((v) => parseInt(v, 10)) : [];
  reportedQ.slice(0, 4).forEach((v, i) => {
    if (plays.length && Number.isFinite(v) && v !== quarterTotals[i]) {
      warnings.push(`${QUARTER_LABELS[i]}: el acta indica ${v} puntos y los marcados suman ${quarterTotals[i]}.`);
    }
  });

  for (const line of lines.values()) {
    if (line.played === null) line.played = line.pts > 0 || (line.fouls || 0) > 0;
    else if (line.pts > 0 || (line.fouls || 0) > 0) line.played = true;
  }

  const rows = [...lines.values()].sort((a, b) => {
    if (b.pts !== a.pts) return b.pts - a.pts;
    if (a.onRoster !== b.onRoster) return a.onRoster ? -1 : 1;
    return (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0);
  });

  const totals = rows.reduce(
    (acc, r) => {
      acc.pts += r.pts;
      acc.fg2 += r.fg2;
      acc.fg3 += r.fg3;
      acc.ftm += r.ftm;
      acc.fouls += r.fouls || 0;
      r.quarters.forEach((v, i) => { acc.quarters[i] += v; });
      return acc;
    },
    { pts: 0, fg2: 0, fg3: 0, ftm: 0, fouls: 0, quarters: [0, 0, 0, 0] },
  );

  return {
    name: team.name || '',
    rows,
    totals,
    plays,
    quarterEnds,
    finalScore: finalScore ?? computedTotal,
    hasScoring: plays.length > 0,
    warnings,
  };
}

function deriveQuarterEnds(team, events, warnings) {
  const ends = Array.isArray(team.quarterEndTotals)
    ? team.quarterEndTotals.map((v) => parseInt(v, 10)).filter((v) => Number.isFinite(v) && v >= 0)
    : [];
  if (ends.length >= 1) {
    const sorted = [...ends].sort((a, b) => a - b);
    if (sorted.some((v, i) => v !== ends[i])) {
      warnings.push('Los finales de cuarto no están en orden creciente; se han ordenado.');
    }
    return sorted.slice(0, 4).concat(Array(Math.max(0, 4 - sorted.length)).fill(Infinity));
  }
  const q = Array.isArray(team.quarterScores) ? team.quarterScores.map((v) => parseInt(v, 10)) : [];
  if (q.length >= 1 && q.every(Number.isFinite)) {
    let acc = 0;
    const out = q.slice(0, 4).map((v) => (acc += v));
    while (out.length < 4) out.push(Infinity);
    return out;
  }
  if (events.length) {
    warnings.push('No se han encontrado los finales de cuarto; todos los puntos van a Q1.');
  }
  return [Infinity, Infinity, Infinity, Infinity];
}

export function computeBoxScore(extraction) {
  const teams = Array.isArray(extraction?.teams) ? extraction.teams : [];
  return {
    game: extraction?.game || {},
    teams: teams.map((t) => ({ side: t.side || '', ...computeTeamBoxScore(t) })),
  };
}

// ---------- Partidos guardados y acumulados ----------

export function teamKey(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function playerKey(row) {
  if (row.name) return `n:${teamKey(row.name)}`;
  return `j:${row.number}`;
}

/** Convierte '19/09/2026', '19-9-26' o '2026-09-19' a 'YYYY-MM-DD' (o '' si no se entiende). */
export function parseGameDate(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return '';
}

export function listTeams(games) {
  const teams = new Map();
  for (const g of games) {
    for (const t of g.extraction?.teams || []) {
      const key = teamKey(t.name);
      if (!key) continue;
      const entry = teams.get(key) || { key, name: t.name, games: 0, withScoring: 0 };
      entry.games += 1;
      if ((t.scoring || []).length) entry.withScoring += 1;
      teams.set(key, entry);
    }
  }
  return [...teams.values()].sort((a, b) => b.withScoring - a.withScoring || b.games - a.games || a.name.localeCompare(b.name));
}

/**
 * games: [{ id, extraction }]. Devuelve, para el equipo indicado, la lista de partidos
 * (ordenados por fecha) y el acumulado por jugador.
 */
export function aggregateTeam(games, key) {
  const matches = [];
  for (const g of games) {
    const box = computeBoxScore(g.extraction);
    const idx = box.teams.findIndex((t) => teamKey(t.name) === key);
    if (idx < 0) continue;
    const team = box.teams[idx];
    const opp = box.teams.find((_, i) => i !== idx);
    const date = parseGameDate(box.game?.date);
    matches.push({
      id: g.id,
      date,
      dateLabel: box.game?.date || '',
      competition: box.game?.competition || '',
      opponent: opp?.name || '',
      teamIndex: idx,
      team,
      pointsFor: team.finalScore,
      pointsAgainst: opp ? opp.finalScore : null,
    });
  }
  matches.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));

  const players = new Map();
  matches.forEach((m, gi) => {
    if (!m.team.hasScoring) return;
    for (const r of m.team.rows) {
      const k = r.onRoster ? playerKey(r) : `x:${r.number}`;
      const p = players.get(k) || {
        key: k, name: r.name, number: r.number, onRoster: r.onRoster,
        gp: 0, pts: 0, fg2: 0, fg3: 0, ftm: 0, fouls: 0, perGame: Array(matches.length).fill(null),
      };
      p.number = r.number;
      if (r.name) p.name = r.name;
      if (r.played) p.gp += 1;
      p.pts += r.pts;
      p.fg2 += r.fg2;
      p.fg3 += r.fg3;
      p.ftm += r.ftm;
      p.fouls += r.fouls || 0;
      p.perGame[gi] = r.played ? r.pts : null;
      players.set(k, p);
    }
  });

  const rows = [...players.values()].sort((a, b) => b.pts - a.pts || b.gp - a.gp);
  const scored = matches.filter((m) => m.team.hasScoring);
  const record = matches.reduce((acc, m) => {
    if (m.pointsAgainst === null) return acc;
    if (m.pointsFor > m.pointsAgainst) acc.w += 1;
    else if (m.pointsFor < m.pointsAgainst) acc.l += 1;
    return acc;
  }, { w: 0, l: 0 });
  return {
    matches,
    rows,
    record,
    gamesWithStats: scored.length,
    pointsFor: matches.reduce((a, m) => a + (m.pointsFor || 0), 0),
    pointsAgainst: matches.reduce((a, m) => a + (m.pointsAgainst || 0), 0),
  };
}
