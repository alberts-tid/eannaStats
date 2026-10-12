import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  computeBoxScore, computeTeamBoxScore, aggregateTeam, listTeams, teamKey, parseGameDate,
} from '../boxscore.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/eanna-drogheda.json', import.meta.url), 'utf8'));

function line(team, number) {
  const row = team.rows.find((r) => r.number === number);
  assert.ok(row, `falta el dorsal ${number}`);
  return [row.pts, row.fg2, row.fg3, row.ftm, row.fouls, ...row.quarters];
}

test('reproduce el box score Éanna BC 114-38', () => {
  const box = computeBoxScore(fixture);
  const eanna = box.teams[0];
  assert.deepEqual(eanna.warnings.filter((w) => !w.includes('dorsal 12')), []);
  assert.deepEqual(eanna.totals.quarters, [36, 28, 22, 28]);
  assert.equal(eanna.totals.pts, 114);
  assert.equal(eanna.totals.fg2, 45);
  assert.equal(eanna.totals.fg3, 4);
  assert.equal(eanna.totals.ftm, 12);

  const expected = {
    6: [31, 6, 4, 7, 2, 8, 10, 7, 6],
    28: [18, 8, 0, 2, 3, 6, 4, 4, 4],
    14: [12, 6, 0, 0, 1, 8, 2, 0, 2],
    18: [12, 6, 0, 0, 2, 4, 0, 4, 4],
    17: [12, 5, 0, 2, 0, 0, 6, 0, 6],
    1: [9, 4, 0, 1, 1, 0, 2, 3, 4],
    0: [8, 4, 0, 0, 1, 6, 0, 2, 0],
    3: [6, 3, 0, 0, 2, 2, 4, 0, 0],
    11: [4, 2, 0, 0, 2, 0, 0, 2, 2],
    12: [2, 1, 0, 0, null, 2, 0, 0, 0],
    2: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  for (const [num, values] of Object.entries(expected)) {
    assert.deepEqual(line(eanna, num), values, `dorsal ${num}`);
  }
  assert.equal(eanna.rows[0].number, '6');
  assert.equal(eanna.rows.find((r) => r.number === '12').onRoster, false);
  assert.equal(box.teams[1].hasScoring, false);
});

test('avisa de saltos imposibles y de cuartos que no cuadran', () => {
  const team = computeTeamBoxScore({
    players: [{ number: '5', name: 'A', fouls: 1 }],
    scoring: [
      { total: 2, jersey: '5' },
      { total: 6, jersey: '5' },
      { total: 9, jersey: '5', threePointer: false },
    ],
    quarterEndTotals: [6, 9],
    quarterScores: [6, 2],
    finalScore: 10,
  });
  const row = team.rows[0];
  assert.equal(row.pts, 9);
  assert.equal(row.fg2, 1);
  assert.equal(row.fg3, 1);
  assert.equal(row.other, 4);
  assert.deepEqual(row.quarters, [6, 3, 0, 0]);
  assert.ok(team.warnings.some((w) => w.includes('+4')));
  assert.ok(team.warnings.some((w) => w.includes('rodeado')));
  assert.ok(team.warnings.some((w) => w.includes('Q2')));
  assert.ok(team.warnings.some((w) => w.includes('10')));
});

test('ordena el marcador, ignora repetidos y normaliza dorsales', () => {
  const team = computeTeamBoxScore({
    players: [{ number: '07', name: 'B' }],
    scoring: [
      { total: 3, jersey: '#7', threePointer: true },
      { total: 1, jersey: '7' },
      { total: 3, jersey: '7' },
    ],
    quarterScores: [3, 0, 0, 0],
  });
  assert.deepEqual(line(team, '7'), [3, 1, 0, 1, 0, 3, 0, 0, 0]);
  assert.ok(team.warnings.some((w) => w.includes('rodeado')));
  assert.ok(team.warnings.some((w) => w.includes('repetido')));
});

test('acumula estadísticas por jugador entre partidos', () => {
  const second = {
    game: { date: '26/9/26', competition: 'League' },
    teams: [
      { side: 'A', name: 'UCD Marian', players: [], scoring: [], finalScore: 50 },
      {
        side: 'B',
        name: 'EANNA BC',
        players: [
          { number: '6', name: 'Jamie Charles', fouls: 4, played: true },
          { number: '2', name: 'Liam Walsh', fouls: 1, played: true },
          { number: '9', name: 'New Kid', fouls: 0, played: false },
        ],
        scoring: [
          { total: 3, jersey: '6', threePointer: true },
          { total: 5, jersey: '2' },
          { total: 6, jersey: '6' },
        ],
        quarterEndTotals: [3, 6],
        finalScore: 6,
      },
    ],
  };
  const noStats = {
    game: { date: '2026-10-03' },
    teams: [
      { name: 'Éanna BC', players: [], scoring: [], finalScore: 70 },
      { name: 'Other', players: [], scoring: [], finalScore: 60 },
    ],
  };
  const games = [
    { id: 'b', extraction: second },
    { id: 'c', extraction: noStats },
    { id: 'a', extraction: fixture },
  ];
  const teams = listTeams(games);
  assert.equal(teams[0].key, 'eanna bc');
  assert.equal(teams[0].games, 3);

  const agg = aggregateTeam(games, teamKey('Éanna BC'));
  assert.deepEqual(agg.matches.map((m) => m.id), ['a', 'b', 'c']);
  assert.deepEqual(agg.record, { w: 2, l: 1 });
  assert.equal(agg.gamesWithStats, 2);
  assert.equal(agg.pointsFor, 114 + 6 + 70);

  const jamie = agg.rows.find((r) => r.name === 'Jamie Charles');
  assert.deepEqual([jamie.gp, jamie.pts, jamie.fg2, jamie.fg3, jamie.ftm, jamie.fouls], [2, 35, 6, 5, 8, 6]);
  assert.deepEqual(jamie.perGame, [31, 4, null]);
  const liam = agg.rows.find((r) => r.name === 'Liam Walsh');
  assert.deepEqual([liam.gp, liam.pts, liam.fouls], [1, 2, 1]);
  assert.deepEqual(liam.perGame, [null, 2, null]);
  const kid = agg.rows.find((r) => r.name === 'New Kid');
  assert.equal(kid.gp, 0);
  assert.ok(agg.rows.some((r) => !r.onRoster && r.number === '12'));
});

test('entiende formatos de fecha habituales', () => {
  assert.equal(parseGameDate('19/09/2026'), '2026-09-19');
  assert.equal(parseGameDate('1-9-26'), '2026-09-01');
  assert.equal(parseGameDate('2026-10-03'), '2026-10-03');
  assert.equal(parseGameDate('Sunday'), '');
});
