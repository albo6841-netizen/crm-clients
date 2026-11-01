// Tests de la logique des livraisons (données fictives).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../delivery-core.js');

test('téléphone : formats israéliens courants → +972…', () => {
  assert.equal(D.normalizePhone('050-123-4567'), '+972501234567');
  assert.equal(D.normalizePhone('0501234567'), '+972501234567');
  assert.equal(D.normalizePhone(' 050 123 4567 '), '+972501234567');
  assert.equal(D.normalizePhone('+972 50-123-4567'), '+972501234567');
  assert.equal(D.normalizePhone('+972 050-123-4567'), '+972501234567', 'le 0 en trop après +972');
  assert.equal(D.normalizePhone('00972501234567'), '+972501234567');
  assert.equal(D.normalizePhone('972501234567'), '+972501234567');
  assert.equal(D.normalizePhone('03-123-4567'), '+97231234567', 'fixe à 9 chiffres');
});
test('téléphone : autres pays au format international', () => {
  assert.equal(D.normalizePhone('+33 6 12 34 56 78'), '+33612345678');
});
test('téléphone : numéros inutilisables → null', () => {
  for (const bad of ['', null, 'abc', '12345', '050-12', '+972 50 123', '+0501234567', '0501234567890', '+97250123456789'])
    assert.equal(D.normalizePhone(bad), null, String(bad));
});
test('téléphone : affichage local', () => {
  assert.equal(D.displayPhone('+972501234567'), '050-123-4567');
  assert.equal(D.displayPhone('+97231234567'), '03-123-4567');
  assert.equal(D.displayPhone('+33612345678'), '+33612345678');
});

test('statut : une explication est obligatoire pour une livraison partielle ou un problème', () => {
  assert.equal(D.checkStatusInput('delivered', ''), null);
  assert.ok(D.checkStatusInput('partial', ''));
  assert.ok(D.checkStatusInput('absent', ' a '));
  assert.equal(D.checkStatusInput('impossible', 'החנות סגורה'), null);
  assert.ok(D.checkStatusInput('done', 'x'), 'statut inconnu refusé');
  assert.ok(D.checkStatusInput(null, 'x'));
});

const stops = [
  { id: 'c', position: 3, delivery_status: null },
  { id: 'a', position: 1, delivery_status: 'delivered' },
  { id: 'b', position: 2, delivery_status: 'absent', problem_resolved_at: null },
  { id: 'd', position: null, created_at: '2026-11-01T08:00:00Z', delivery_status: null },
  { id: 'e', position: 4, delivery_status: 'partial', problem_resolved_at: '2026-11-01T12:00:00Z' }
];
test('tournée : ordre, prochain arrêt, progression', () => {
  const o = D.orderStops(stops);
  assert.deepEqual(o.map(s => s.id), ['a', 'b', 'c', 'e', 'd']);
  assert.equal(D.nextStop(o).id, 'c');
  const p = D.progress(stops);
  assert.deepEqual(p, { total: 5, done: 3, delivered: 1, problems: 2, openProblems: 1, remaining: 2, pct: 60 });
  assert.equal(D.nextStop(o.filter(s => s.delivery_status)), null);
  assert.deepEqual(D.progress([]), { total: 0, done: 0, delivered: 0, problems: 0, openProblems: 0, remaining: 0, pct: 0 });
});
test('tournée : statut affiché (icône + texte), jamais seulement une couleur', () => {
  for (const k of Object.keys(D.STATUSES)) { const s = D.STATUSES[k]; assert.ok(s.label && s.icon, k); }
  assert.equal(D.statusInfo('inconnu').label, D.STATUSES.pending.label);
  assert.equal(D.isProblem({ delivery_status: 'partial' }), true);
  assert.equal(D.openProblem({ delivery_status: 'partial', problem_resolved_at: 'x' }), false);
});

test('mes tournées : celle du jour, puis les prochaines, puis les précédentes', () => {
  const r = D.splitTrips([{ id: 1, date: '2026-11-03' }, { id: 2, date: '2026-11-01' }, { id: 3, date: '2026-10-30' }, { id: 4, date: '2026-11-02' }, { id: 5, date: '2026-10-31' }], '2026-11-01');
  assert.deepEqual(r.today.map(t => t.id), [2]);
  assert.deepEqual(r.upcoming.map(t => t.id), [4, 1]);
  assert.deepEqual(r.past.map(t => t.id), [5, 3]);
});
test('secteur : villes sans doublon, abrégé au-delà de 3', () => {
  assert.equal(D.areaOf(['נתניה', ' נתניה', 'חדרה', '', null]), 'נתניה · חדרה');
  assert.equal(D.areaOf(['א', 'ב', 'ג', 'ד', 'ה']), 'א · ב · ג +2');
});

test('connexion : messages compréhensibles pour chaque erreur', () => {
  assert.equal(D.authError({ message: 'Signups not allowed for otp' }).kind, 'unknown');
  const w = D.authError({ message: 'For security purposes, you can only request this after 42 seconds.', status: 429 });
  assert.equal(w.kind, 'wait'); assert.equal(w.seconds, 42);
  assert.equal(D.authError({ message: 'Token has expired or is invalid', code: 'otp_expired' }).kind, 'code');
  assert.equal(D.authError({ message: 'User is banned' }).kind, 'inactive');
  assert.equal(D.authError({ message: 'driver_inactive' }).kind, 'inactive');
  assert.equal(D.authError({ message: 'Unable to get SMS provider' }).kind, 'sms');
  assert.equal(D.authError({ message: 'Error sending confirmation OTP to provider: sms not configured' }).kind, 'sms');
  assert.equal(D.authError(new TypeError('Failed to fetch')).kind, 'network');
  assert.equal(D.authError({ message: 'Request rate limit reached', status: 429 }).kind, 'limit');
  assert.equal(D.authError({ message: '???' }).kind, 'other');
  for (const k of ['unknown', 'code', 'inactive', 'sms', 'network']) assert.ok(/[֐-׿]/.test(D.authError({ message: k === 'unknown' ? 'Signups not allowed for otp' : k === 'code' ? 'Token has expired or is invalid' : k === 'inactive' ? 'User is banned' : k === 'sms' ? 'Unable to get SMS provider' : 'Failed to fetch' }).text), 'texte en hébreu : ' + k);
});

test('pièces : chemin rangé par tournée et arrêt ; textes des SMS sans information sensible', () => {
  assert.equal(D.proofPath('T', 'S', 'X'), 'T/S/X.jpg');
  const n = D.notifyText('https://exemple.test/driver');
  assert.ok(n.includes('https://exemple.test/driver'));
  assert.ok(!/₪|\d{3,}/.test(n.replace('https://exemple.test/driver', '')), 'ni montant ni numéro');
  assert.ok(D.otpText('123456').includes('123456'));
});
