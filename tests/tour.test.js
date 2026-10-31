// Tests de la logique de tournée (מסלולים) : ordre, prochain arrêt, progression, heures prévues.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tour.js');

const S = (id, extra = {}) => Object.assign({ id, done: false, skipped: false, position: null, createdAt: '2026-10-01T00:00:00Z' }, extra);

test('ordre : par position, les arrêts sans position à la fin (dans l\'ordre de création)', () => {
  const o = T.orderStops([
    S('c', { position: null, createdAt: '2026-10-03' }),
    S('a', { position: 2 }),
    S('b', { position: 1 }),
    S('d', { position: null, createdAt: '2026-10-02' }),
  ]);
  assert.deepEqual(o.map(s => s.id), ['b', 'a', 'd', 'c']);
});

test('prochain arrêt : le premier ni fait ni « pas visité »', () => {
  const o = [S('a', { done: true }), S('b', { skipped: true }), S('c'), S('d')];
  assert.equal(T.nextStop(o).id, 'c');
  assert.equal(T.nextStop([S('a', { done: true })]), null);
});

test('progression : faits, pas visités, restants, étiquette', () => {
  assert.deepEqual(T.tripStatus([]), { total: 0, done: 0, skipped: 0, handled: 0, remaining: 0, label: 'ריק' });
  assert.equal(T.tripStatus([S('a'), S('b')]).label, 'מתוכנן');
  const s = T.tripStatus([S('a', { done: true }), S('b', { skipped: true }), S('c')]);
  assert.deepEqual(s, { total: 3, done: 1, skipped: 1, handled: 2, remaining: 1, label: 'בתהליך' });
  assert.equal(T.tripStatus([S('a', { done: true }), S('b', { skipped: true })]).label, 'הושלם');
});

test('↑ : échange avec l\'arrêt précédent et renumérote 1..n', () => {
  const o = [S('a'), S('b'), S('c')];
  assert.deepEqual(T.moveUp(o, 'c'), [{ id: 'a', position: 1 }, { id: 'c', position: 2 }, { id: 'b', position: 3 }]);
  assert.deepEqual(T.moveUp(o, 'a'), [{ id: 'a', position: 1 }, { id: 'b', position: 2 }, { id: 'c', position: 3 }]);
});

test('heures prévues : départ, trajet à 50 km/h × 1,3, 15 min par visite ; les « pas visité » sont sautés', () => {
  // points espacés d'environ 11,1 km (0,1° de latitude) → 11,1×1,3/50 h ≈ 17,3 min
  const start = [32.0, 34.8];
  const o = [S('a', { ll: [32.1, 34.8] }), S('x', { ll: [32.15, 34.8], skipped: true }), S('b', { ll: [32.2, 34.8] })];
  const r = T.planEtas({ startLL: start, startTime: '08:00', stops: o, endLL: start });
  assert.equal(r.etas.a, '08:17');
  assert.equal(r.etas.x, undefined);
  assert.equal(r.etas.b, '08:50');   // 08:17 + 15 min de visite + 17 min de route
  assert.equal(r.finish, '09:39');    // + 15 min de visite + 34,7 min de retour (529,7 + 15 + 34,7 = 579,4 min)
});

test('heures prévues sans adresse de départ : le 1er arrêt à l\'heure de départ', () => {
  const o = [S('a', { ll: [32.1, 34.8] }), S('b', { ll: [32.2, 34.8] })];
  const r = T.planEtas({ startLL: null, startTime: '09:00', stops: o, endLL: null });
  assert.equal(r.etas.a, '09:00');
  assert.equal(r.etas.b, '09:32');
  assert.equal(r.finish, '09:47');
});

test('heures prévues : un arrêt sans position GPS n\'a pas d\'heure, le calcul continue', () => {
  const o = [S('a', { ll: [32.1, 34.8] }), S('n', { ll: null }), S('b', { ll: [32.2, 34.8] })];
  const r = T.planEtas({ startLL: [32.0, 34.8], startTime: '08:00', stops: o, endLL: null });
  assert.equal(r.etas.n, undefined);
  assert.equal(r.etas.b, '08:50');
});

test('ordre le plus court : plus proche voisin + 2-opt, départ et arrivée fixes', () => {
  const pts = [S('c', { ll: [32.3, 34.8] }), S('a', { ll: [32.1, 34.8] }), S('b', { ll: [32.2, 34.8] })];
  assert.deepEqual(T.optimizeOrder([32.0, 34.8], pts, [32.0, 34.8]).map(s => s.id), ['a', 'b', 'c']);
});

test('ordre le plus court : les arrêts sans GPS gardent leur place à la fin', () => {
  const pts = [S('n', { ll: null }), S('b', { ll: [32.2, 34.8] }), S('a', { ll: [32.1, 34.8] })];
  assert.deepEqual(T.optimizeOrder([32.0, 34.8], pts, null).map(s => s.id), ['a', 'b', 'n']);
});
