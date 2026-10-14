import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateTeam, findEannaKey } from '../boxscore.js';
import {
  absentFromSheet, applyRoster, jerseyKey, rosterContext, rosterFromGames, rosterRows, sameName, withListEdits,
} from '../roster.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/eanna-drogheda.json', import.meta.url), 'utf8'));

test('normaliza el dorsal igual que el box score', () => {
  assert.equal(jerseyKey('#07'), '7');
  assert.equal(jerseyKey('00'), '00');
  assert.equal(jerseyKey('0'), '0');
  assert.equal(jerseyKey(' 14 '), '14');
  assert.equal(jerseyKey(''), '');
  assert.equal(sameName('Seán Bolger', 'sean bolger'), true);
  assert.equal(sameName('Jamie Charls', 'Jamie Charles'), false);
  assert.equal(sameName('', 'Mark'), false);
});

test('la lista sale de la primera acta de Éanna que tiene nombres', () => {
  const later = structuredClone(fixture);
  later.game.date = '26/09/2026';
  later.teams[0].name = 'EANNA';
  const undated = structuredClone(fixture);
  undated.game.date = '';
  const games = [
    { id: 'z', extraction: later },
    { id: 'b', extraction: undated },
    { id: 'a', extraction: fixture },
  ];
  const roster = rosterFromGames(games);
  assert.equal(roster.id, 'a');
  assert.equal(roster.date, '2026-09-19');
  assert.equal(roster.players.find((p) => p.number === '6').name, 'Jamie Charles');
  assert.equal(roster.players.find((p) => p.number === '0').name, 'Darragh Comiskey');

  const sameDay = rosterFromGames([
    { id: 'm', extraction: fixture },
    { id: 'a', extraction: fixture },
  ]);
  assert.equal(sameDay.id, 'a');
  const bySave = rosterFromGames([
    { id: 'a', createdAt: { seconds: 200 }, extraction: fixture },
    { id: 'b', createdAt: { seconds: 100 }, extraction: fixture },
  ]);
  assert.equal(bySave.id, 'b');
});

test('el acta abierto es la lista solo si no hay otra anterior', () => {
  const later = structuredClone(fixture);
  later.game.date = '03/10/2026';
  const games = [
    { id: 'first', extraction: fixture },
    { id: 'second', extraction: later },
  ];
  assert.equal(rosterContext(games, fixture, 'first').source, true);
  assert.equal(rosterContext(games, later, 'second').source, false);
  assert.equal(rosterContext(games, later, 'second').id, 'first');
  assert.equal(rosterContext([], fixture, null).source, true);
  const fresh = structuredClone(later);
  assert.equal(rosterContext(games, fresh, null).source, false);
  const earlier = structuredClone(fixture);
  earlier.game.date = '01/09/2026';
  assert.equal(rosterContext(games, earlier, null).source, true);
});

test('aplica los nombres de la lista sin añadir ni tocar al rival', () => {
  const later = structuredClone(fixture);
  later.game.date = '26/09/2026';
  const jamie = later.teams[0].players.find((p) => p.number === '6');
  jamie.name = 'Jamie Charls';
  const sean = later.teams[0].players.find((p) => p.number === '17');
  sean.name = 'Seán Bolger';
  later.teams[0].players.push({ number: '9', name: 'New Kid', fouls: 1, played: true });
  const roster = rosterFromGames([
    { id: 'first', extraction: fixture },
    { id: 'later', extraction: later },
  ]);
  const fixed = applyRoster(later, roster);
  assert.equal(fixed.teams[0].players.find((p) => p.number === '6').name, 'Jamie Charles');
  assert.equal(fixed.teams[0].players.find((p) => p.number === '17').name, 'Sean Bolger');
  assert.equal(fixed.teams[0].players.find((p) => p.number === '9').name, 'New Kid');
  assert.equal(fixed.teams[0].players.some((p) => p.number === '12'), false);
  assert.equal(later.teams[0].players.find((p) => p.number === '6').name, 'Jamie Charls');
  assert.equal(fixed.teams[1].players.find((p) => p.number === '4').name, 'Jakub Grimm');

  const games = [
    { id: 'first', extraction: fixture },
    { id: 'later', extraction: fixed },
  ];
  const agg = aggregateTeam(games, findEannaKey(games));
  const names = agg.rows.filter((r) => /jamie/i.test(r.name)).map((r) => r.name);
  assert.deepEqual(names, ['Jamie Charles']);
  assert.equal(agg.rows.find((r) => r.number === '17').name, 'Sean Bolger');
});

test('marca dorsales vacíos, repetidos, ajenos a la lista y nombres que no coinciden', () => {
  const list = [
    { number: '6', name: 'Jamie Charles' },
    { number: '17', name: 'Sean Bolger' },
    { number: '2', name: 'Liam Walsh' },
  ];
  const rows = rosterRows([
    { number: '6', name: 'Jamie Charls' },
    { number: '', name: 'Sin dorsal' },
    { number: '17', name: 'Seán Bolger' },
    { number: '9', name: 'New Kid' },
    { number: '6', name: 'Otro' },
    { number: '2', name: '' },
  ], list);
  assert.match(rows[0].doubts.join(' '), /Jamie Charls/);
  assert.equal(rows[0].nameDoubt, true);
  assert.equal(rows[0].listName, 'Jamie Charles');
  assert.match(rows[1].doubts.join(' '), /No jersey/);
  assert.equal(rows[2].doubts.length, 0);
  assert.match(rows[3].doubts.join(' '), /not on the player list/);
  assert.match(rows[4].doubts.join(' '), /repeated/);
  assert.match(rows[5].doubts.join(' '), /Name not read/);
  const absent = absentFromSheet([
    { number: '6', name: 'Jamie Charls' },
    { number: '17', name: 'Sean Bolger' },
  ], list);
  assert.deepEqual(absent.map((p) => p.number), ['2']);
});

test('una corrección de la lista cambia el nombre y puede añadir un dorsal', () => {
  const roster = { id: 'first', players: [{ number: '6', name: 'Jamie Charles' }] };
  const edits = new Map([['6', 'Jamie C.'], ['9', 'New Kid'], ['14', '  ']]);
  const merged = withListEdits(roster, edits);
  assert.equal(merged.players.find((p) => p.number === '6').name, 'Jamie C.');
  assert.equal(merged.players.find((p) => p.number === '9').name, 'New Kid');
  assert.equal(merged.players.some((p) => p.number === '14'), false);
  assert.equal(roster.players[0].name, 'Jamie Charles');
});
