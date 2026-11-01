// Tests de l'ordre des tournées : places fixes, cadenas, ordre manuel, proposition, heures limites (données fictives).
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../route-plan.js');

const S = (id, o = {}) => Object.assign({ id, handled: false, locked: 0, ll: null }, o);

test('arrange : sans place fixe, l\'ordre voulu est suivi', () => {
  const stops = [S('a'), S('b'), S('c')];
  assert.deepEqual(R.arrange(stops), ['a', 'b', 'c']);
  assert.deepEqual(R.arrange(stops, ['c', 'a', 'b']), ['c', 'a', 'b']);
});

test('arrange : un arrêt traité garde sa place, un cadenas aussi', () => {
  const stops = [S('a', { handled: true }), S('b'), S('c', { locked: 4 }), S('d'), S('e')];
  // c est verrouillé en 4e place, a (traité) reste en 1re
  assert.deepEqual(R.arrange(stops, ['e', 'd', 'b']), ['a', 'e', 'd', 'c', 'b']);
});

test('arrange : cadenas plus loin que la fin → dernière place ; deux cadenas sur la même place', () => {
  assert.deepEqual(R.arrange([S('a', { locked: 9 }), S('b'), S('c')]), ['b', 'c', 'a']);
  const r = R.arrange([S('a', { locked: 2 }), S('b', { locked: 2 }), S('c')]);
  assert.equal(r[1], 'a');
  assert.equal(r.length, 3);
  assert.ok(r.includes('b') && r.includes('c'));
});

test('arrange : un cadenas ne prend jamais la place d\'un arrêt traité', () => {
  const r = R.arrange([S('a', { handled: true }), S('b', { locked: 1 }), S('c')]);
  assert.equal(r[0], 'a');
  assert.equal(r[1], 'b', 'la place libre la plus proche');
});

test('move : échange avec le voisin, refusé contre un arrêt fixe ou au bord', () => {
  const stops = [S('a', { handled: true }), S('b'), S('c'), S('d', { locked: 4 })];
  assert.deepEqual(R.move(stops, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.equal(R.move(stops, 'b', -1), null, 'au-dessus : arrêt traité');
  assert.equal(R.move(stops, 'c', 1), null, 'en dessous : cadenas');
  assert.equal(R.move(stops, 'd', -1), null, 'arrêt verrouillé');
  assert.equal(R.move([S('x'), S('y')], 'x', -1), null, 'bord');
});

test('makeFirst : prend la première place libre, sans bouger traités ni cadenas', () => {
  const stops = [S('a', { handled: true }), S('b'), S('c', { locked: 3 }), S('d'), S('e')];
  assert.deepEqual(R.makeFirst(stops, 'e'), ['a', 'e', 'c', 'b', 'd']);
  assert.equal(R.makeFirst(stops, 'a'), null, 'un arrêt traité ne bouge pas');
  assert.equal(R.makeFirst(stops, 'c'), null, 'un arrêt verrouillé ne bouge pas');
});

test('suggest : refuse s\'il manque des positions', () => {
  const r = R.suggest([S('a', { ll: [32, 34.8] }), S('b')], [32, 34.8], null);
  assert.equal(r.order, null);
  assert.deepEqual(r.missing, ['b']);
});

test('suggest : plus proche voisin depuis le départ, places fixes respectées', () => {
  // le long d'une ligne nord-sud : départ au sud
  const stops = [S('far', { ll: [32.30, 34.85] }), S('mid', { ll: [32.20, 34.85] }), S('near', { ll: [32.10, 34.85] })];
  assert.deepEqual(R.suggest(stops, [32.00, 34.85], null).order, ['near', 'mid', 'far']);
  // « far » verrouillé en 1re place : il y reste
  const locked = [S('far', { ll: [32.30, 34.85], locked: 1 }), S('mid', { ll: [32.20, 34.85] }), S('near', { ll: [32.10, 34.85] })];
  assert.equal(R.suggest(locked, [32.00, 34.85], null).order[0], 'far');
  // un arrêt traité sans position ne bloque pas la proposition
  const done = [S('x', { handled: true }), S('b', { ll: [32.2, 34.85] }), S('a', { ll: [32.1, 34.85] })];
  assert.deepEqual(R.suggest(done, [32.0, 34.85], null).order, ['x', 'a', 'b']);
});

test('detectTime : heures limites dans le texte, sinon rien', () => {
  assert.equal(R.detectTime('קבלת סחורה עד 12:00').time, '12:00');
  assert.equal(R.detectTime('להגיע לפני 9:30 בבוקר').time, '09:30');
  assert.equal(R.detectTime('עד השעה 14.15 בלבד').time, '14:15');
  assert.ok(R.detectTime('קבלת סחורה עד 12:00, לתאם').excerpt.includes('עד 12:00'));
  assert.equal(R.detectTime('עד 12 ארגזים'), null, 'pas d\'heure sans minutes');
  assert.equal(R.detectTime('הטלפון 052-1234567'), null);
  assert.equal(R.detectTime(''), null);
});
