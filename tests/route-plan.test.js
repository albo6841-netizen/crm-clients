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

test('move : échange avec la place libre voisine, et explique les refus', () => {
  const stops = [S('a', { handled: true }), S('b'), S('c'), S('d', { locked: 4 })];
  assert.deepEqual(R.move(stops, 'c', -1), ['a', 'c', 'b', 'd']);
  assert.equal(R.move(stops, 'b', -1), null);
  assert.deepEqual(R.moveBlock(stops, 'b', -1), { code: 'fixed-beyond' }, 'au-dessus : seulement un arrêt traité');
  assert.deepEqual(R.moveBlock(stops, 'c', 1), { code: 'fixed-beyond' }, 'en dessous : seulement un cadenas');
  assert.deepEqual(R.moveBlock(stops, 'd', -1), { code: 'self-locked', slot: 4 });
  assert.deepEqual(R.moveBlock(stops, 'a', 1), { code: 'self-handled' });
  assert.deepEqual(R.moveBlock([S('x'), S('y')], 'x', -1), { code: 'edge' });
  assert.equal(R.moveBlock(stops, 'c', -1), null);
});

test('move : passe par-dessus un arrêt traité ou verrouillé sans le déplacer', () => {
  assert.deepEqual(R.move([S('a'), S('b', { handled: true }), S('c')], 'c', -1), ['c', 'b', 'a']);
  assert.deepEqual(R.move([S('a'), S('b', { locked: 2 }), S('c')], 'a', 1), ['c', 'b', 'a']);
});

test('makeFirst : prend la première place libre, sans bouger traités ni cadenas', () => {
  const stops = [S('a', { handled: true }), S('b'), S('c', { locked: 3 }), S('d'), S('e')];
  assert.deepEqual(R.makeFirst(stops, 'e'), ['a', 'e', 'c', 'b', 'd']);
  assert.equal(R.makeFirst(stops, 'a'), null, 'un arrêt traité ne bouge pas');
  assert.equal(R.makeFirst(stops, 'c'), null, 'un arrêt verrouillé ne bouge pas');
  assert.deepEqual(R.firstBlock(stops, 'c'), { code: 'self-locked', slot: 3 });
  assert.deepEqual(R.firstBlock(stops, 'b'), { code: 'already-first' });
  assert.deepEqual(R.firstBlock(stops, 'a'), { code: 'self-handled' });
});

test('500 tournées au hasard : aucune action ne déplace un arrêt traité ni le rang d\'un arrêt verrouillé', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 500; run++) {
    const n = 2 + Math.floor(rnd() * 9), stops = [];
    for (let k = 0; k < n; k++) {
      const handled = rnd() < 0.25, locked = !handled && rnd() < 0.25 ? 1 + Math.floor(rnd() * n) : 0;
      stops.push(S('s' + k, { handled, locked, ll: [32 + rnd() * 0.3, 34.8 + rnd() * 0.2] }));
    }
    const before = R.arrange(stops), fixed = R.fixedSlots(stops);
    const keeps = (order, what) => {
      for (const [slot, id] of fixed) assert.equal(order[slot], id, `run ${run} ${what} : ${id} a quitté la place ${slot + 1}`);
      assert.deepEqual([...order].sort(), [...before].sort(), `run ${run} ${what} : arrêt perdu ou dupliqué`);
    };
    // la place actuelle d'un arrêt traité est bien gardée par arrange
    stops.forEach((s, k) => { if (s.handled) assert.equal(before[k], s.id); });
    const cur = before.map(id => stops.find(s => s.id === id));   // les ops partent de l'ordre rangé
    assert.deepEqual([...R.fixedSlots(cur)].sort(), [...fixed].sort(), `run ${run} : les places fixes changent après un rangement`);
    for (const s of cur) {
      for (const dir of [-1, 1]) { const o = R.move(cur, s.id, dir); if (o) keeps(o, 'move'); else assert.ok(R.moveBlock(cur, s.id, dir)); }
      const f = R.makeFirst(cur, s.id); if (f) keeps(f, 'makeFirst'); else assert.ok(R.firstBlock(cur, s.id));
    }
    const sug = R.suggest(cur, [32, 34.8], null); if (sug.order) keeps(sug.order, 'suggest');
  }
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

test('publication : un arrêt livré pendant le brouillon et déplacé est détecté, puis remis à sa place', () => {
  // version publiée : A B C D ; l'équipe prépare D C B A + E ; pendant ce temps le livreur livre A
  const pub = ['A', 'B', 'C', 'D'], draft = ['D', 'C', 'A', 'E'], done = new Set(['A']);   // B retiré
  assert.deepEqual(R.handledMoved(pub, draft, done), ['A']);
  const fixed = R.repairHandled(pub, draft, done);
  assert.deepEqual(fixed, ['A', 'D', 'C', 'E'], 'A reprend son rang, D et C gardent l\'ordre de l\'équipe, E (ajouté) garde sa place');
  assert.deepEqual(R.handledMoved(pub, fixed, done), []);
  // un ajout avant un arrêt traité ou un retrait ne comptent pas comme un déplacement
  assert.deepEqual(R.handledMoved(['A', 'B', 'C'], ['N', 'A', 'C'], new Set(['A', 'C'])), []);
});

test('publication : 300 cas au hasard, la réparation garde toujours les arrêts traités à leur rang', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let run = 0; run < 300; run++) {
    const n = 2 + Math.floor(rnd() * 8), pub = Array.from({ length: n }, (_, k) => 'p' + k);
    const draft = pub.filter(() => rnd() > 0.2).sort(() => rnd() - 0.5);
    for (let k = 0; k < 3; k++) if (rnd() < 0.4) draft.splice(Math.floor(rnd() * (draft.length + 1)), 0, 'n' + run + k);
    const done = new Set(pub.filter(() => rnd() < 0.3));
    const fixed = R.repairHandled(pub, draft, done);
    assert.deepEqual([...fixed].sort(), [...draft].sort(), `run ${run} : arrêt perdu`);
    assert.deepEqual(R.handledMoved(pub, fixed, done), [], `run ${run} : arrêt traité encore déplacé`);
    draft.forEach((id, k) => { if (!pub.includes(id)) assert.equal(fixed[k], id, `run ${run} : ajout déplacé`); });
  }
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
