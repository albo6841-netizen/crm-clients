// Tests de l'historique des visites et des alertes « כדאי לשים לב » (données fictives).
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../insights.js');

const TASKS = [
  // arrêt de tournée fait
  { id: 't1', customerId: 'c1', tripId: 'trip1', type: 'route', done: true, doneAt: '2026-10-20T09:15:00.000Z', dueDate: '2026-10-20', visitNote: 'הזמנה חדשה' },
  // arrêt « pas visité » : pas une visite
  { id: 't2', customerId: 'c1', tripId: 'trip2', type: 'route', done: false, skipped: true, dueDate: '2026-10-25' },
  // visite notée depuis la fiche
  { id: 't3', customerId: 'c1', tripId: '', type: 'visit', done: true, doneAt: '2026-10-28T12:00:00.000Z', dueDate: '2026-10-28', visitNote: '' },
  // arrêt prévu, pas encore fait
  { id: 't4', customerId: 'c1', tripId: 'trip3', type: 'route', done: false, dueDate: '2026-11-03' },
  // simple tâche faite, hors tournée : pas une visite
  { id: 't5', customerId: 'c1', tripId: '', type: 'other', done: true, doneAt: '2026-10-29T08:00:00.000Z' },
  // autre client
  { id: 't6', customerId: 'c2', tripId: 'trip1', type: 'payment', done: true, doneAt: '2026-10-20T10:00:00.000Z' },
];

test('historique : arrêts faits + visites notées, la plus récente d\'abord', () => {
  const h = I.visitHistory({ id: 'c1' }, TASKS);
  assert.deepEqual(h.map(v => [v.id, v.date, v.source]), [['t3', '2026-10-28', 'manual'], ['t1', '2026-10-20', 'tour']]);
  assert.equal(h[1].note, 'הזמנה חדשה');
});

test('historique : l\'ancienne date de dernière visite de la fiche est gardée si elle n\'est pas déjà là', () => {
  const h = I.visitHistory({ id: 'c1', lastVisit: '2026-09-01' }, TASKS);
  assert.deepEqual(h.map(v => v.date), ['2026-10-28', '2026-10-20', '2026-09-01']);
  assert.equal(h[2].source, 'legacy');
  // même date qu'une visite déjà connue → pas de doublon
  assert.equal(I.visitHistory({ id: 'c1', lastVisit: '2026-10-28' }, TASKS).length, 2);
});

test('historique : date d\'une visite = jour local de la fin de visite, sinon date prévue', () => {
  const h = I.visitHistory({ id: 'c9' }, [{ id: 'x', customerId: 'c9', type: 'visit', done: true, doneAt: '', dueDate: '2026-10-01' }]);
  assert.equal(h[0].date, '2026-10-01');
});

test('dernière visite : la date la plus récente, vide si jamais visité', () => {
  assert.equal(I.lastVisit({ id: 'c1', lastVisit: '2026-09-01' }, TASKS), '2026-10-28');
  assert.equal(I.lastVisit({ id: 'c3' }, TASKS), '');
});

test('jours écoulés entre deux dates', () => {
  assert.equal(I.daysBetween('2026-10-28', '2026-11-01'), 4);
  assert.equal(I.daysBetween('', '2026-11-01'), null);
});

const STORES = [
  { id: 'a', name: 'א', gps: '32.1,34.8', lastVisit: '2026-10-25' },   // rien à signaler
  { id: 'b', name: 'ב', gps: '32.1,34.8', lastVisit: '2026-10-01' },   // pas visité depuis 31 jours
  { id: 'c', name: 'ג', gps: '', lastVisit: '2026-10-30' },            // GPS manquant
  { id: 'd', name: 'ד', gps: '32.1,34.8', lastVisit: '2026-09-01' },   // retard 45 j + pas visité 61 j → retard d'abord
  { id: 'e', name: 'ה', gps: '32.1,34.8', lastVisit: '' },             // jamais visité : pas d'alerte de visite
  { id: 'f', name: 'ו', gps: 'nimporte', lastVisit: '2026-10-30' },    // GPS illisible = manquant
];
const LATE = { d: 45, a: 10 };

test('alertes : retard ≥ 30 j, puis visite ≥ 21 j, puis GPS manquant ; une seule par client', () => {
  const s = I.suggestions({ stores: STORES, tasks: [], lateDays: id => LATE[id] || 0, today: '2026-11-01' });
  assert.deepEqual(s.map(x => [x.store.id, x.kind, x.days]), [
    ['d', 'late', 45], ['b', 'visit', 31], ['c', 'gps', null], ['f', 'gps', null]
  ]);
});

test('alertes : textes en hébreu', () => {
  const s = I.suggestions({ stores: STORES, tasks: [], lateDays: id => LATE[id] || 0, today: '2026-11-01' });
  assert.deepEqual(s.map(x => x.text), ['יתרה בפיגור של 45 ימים', 'לא בוקר כבר 31 ימים', 'חסר מיקום למפה', 'חסר מיקום למפה']);
});

test('alertes : une visite faite en tournée fait disparaître l\'alerte de visite', () => {
  const tasks = [{ id: 'v', customerId: 'b', tripId: 't', type: 'route', done: true, doneAt: '2026-10-31T09:00:00.000Z' }];
  const s = I.suggestions({ stores: STORES, tasks, lateDays: () => 0, today: '2026-11-01' });
  assert.equal(s.some(x => x.store.id === 'b'), false);
});
