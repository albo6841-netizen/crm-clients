// Tests serveur de l'espace livreurs : qui peut gérer les livreurs, notification, SMS de connexion (données fictives).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { driversHandler, smsHookHandler, verifyStandardWebhook } = require('../api/_lib/drivers.js');
const { syncHandler } = require('../api/_lib/handlers.js');

const ENV = { SUPABASE_SECRET_KEY: 'sb_secret_x' };
const T1 = '11111111-1111-4111-8111-111111111111';
const D1 = '22222222-2222-4222-8222-222222222222';

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
function fakeStore(over = {}) {
  const db = { drivers: [], auth: [], notes: [], events: [], trips: [] };
  let n = 0;
  const store = Object.assign({
    db,
    async userFromToken(t) { return t === 'staff' ? { id: 'staff-1' } : t === 'driver' ? { id: 'auth-d' } : null; },
    async isStaff(uid) { return uid === 'staff-1'; },
    async driverById(id) { return db.drivers.find(d => d.id === id) || null; },
    async driverByPhone(p) { return db.drivers.find(d => d.phone === p) || null; },
    async driverByUser(u) { return db.drivers.find(d => d.user_id === u) || null; },
    async insertDriver(row) { const d = Object.assign({ id: D1 }, row); db.drivers.push(d); return d; },
    async updateDriver(id, f) { const d = db.drivers.find(x => x.id === id); Object.assign(d, f); return d; },
    async activeTripsOf() { return 2; },
    async authUserByPhone(digits) { const u = db.auth.find(a => a.phone === digits); return u ? u.id : null; },
    async createAuthUser(digits) { const id = 'auth-' + (++n); db.auth.push({ id, phone: digits }); return id; },
    async updateAuthUser(uid, f) { const u = db.auth.find(a => a.id === uid); if (u) Object.assign(u, f); return u; },
    async deleteAuthUser(uid) { db.auth = db.auth.filter(a => a.id !== uid); },
    async getTrip(id) { return db.trips.find(t => t.id === id) || null; },
    async addNotification(r) { db.notes.push(r); },
    async addEvent(r) { db.events.push(r); }
  }, over);
  return store;
}
const smsOff = { configured: () => false, async send() { throw new Error('ne doit pas être appelé'); } };
function smsOn(sent, failWith) { return { configured: () => true, async send(to, body) { if (failWith) throw new Error(failWith); sent.push({ to, body }); return 'SM1'; } }; }
const post = (body, token = 'staff') => ({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body });

test('livreurs : sans connexion → 401 ; livreur connecté (hors équipe) → 403', async () => {
  const s = fakeStore();
  let r = res(); await driversHandler({ env: ENV, store: s, sms: smsOff })(post({ action: 'create', name: 'א', phone: '0501234567' }, null), r);
  assert.equal(r.statusCode, 401);
  r = res(); await driversHandler({ env: ENV, store: s, sms: smsOff })(post({ action: 'create', name: 'א', phone: '0501234567' }, 'driver'), r);
  assert.equal(r.statusCode, 403);
  assert.equal(s.db.drivers.length, 0);
});

test('livreurs : ajout → compte de connexion par téléphone créé et relié, numéro au format international', async () => {
  const s = fakeStore(); const r = res();
  await driversHandler({ env: ENV, store: s, sms: smsOff })(post({ action: 'create', name: '  יוסי   כהן ', phone: '050-123-4567' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(s.db.drivers[0], { id: D1, name: 'יוסי כהן', phone: '+972501234567', active: true, user_id: 'auth-1' });
  assert.equal(s.db.auth[0].phone, '972501234567', 'Auth stocke le numéro sans +');
  assert.equal(s.db.auth[0].ban_duration, 'none');
});

test('livreurs : numéro invalide, nom vide, numéro déjà pris → refusés', async () => {
  const s = fakeStore(); const h = driversHandler({ env: ENV, store: s, sms: smsOff });
  let r = res(); await h(post({ action: 'create', name: 'א', phone: '123' }), r); assert.equal(r.body.error, 'bad_phone');
  r = res(); await h(post({ action: 'create', name: ' ', phone: '0501234567' }), r); assert.equal(r.body.error, 'name_required');
  r = res(); await h(post({ action: 'create', name: 'א', phone: '0501234567' }), r); assert.equal(r.statusCode, 200);
  r = res(); await h(post({ action: 'create', name: 'ב', phone: '+972 50-123-4567' }), r); assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'phone_exists');
});

test('livreurs : le numéro d\'un membre de l\'équipe ne peut pas devenir un livreur', async () => {
  const s = fakeStore({ async authUserByPhone() { return 'staff-1'; } }); const r = res();
  await driversHandler({ env: ENV, store: s, sms: smsOff })(post({ action: 'create', name: 'א', phone: '0501234567' }), r);
  assert.equal(r.body.error, 'phone_is_staff');
});

test('livreurs : échec de l\'enregistrement → le compte de connexion créé est retiré', async () => {
  const s = fakeStore({ async insertDriver() { throw new Error('base indisponible'); } }); const r = res();
  await driversHandler({ env: ENV, store: s, sms: smsOff, log() {} })(post({ action: 'create', name: 'א', phone: '0501234567' }), r);
  assert.equal(r.statusCode, 500);
  assert.equal(s.db.auth.length, 0);
});

test('livreurs : désactivation → compte bloqué, et on signale ses tournées encore actives ; réactivation → débloqué', async () => {
  const s = fakeStore(); const h = driversHandler({ env: ENV, store: s, sms: smsOff });
  await h(post({ action: 'create', name: 'א', phone: '0501234567' }), res());
  let r = res(); await h(post({ action: 'set_active', id: D1, active: false }), r);
  assert.equal(s.db.drivers[0].active, false);
  assert.equal(s.db.auth[0].ban_duration, '876000h');
  assert.equal(r.body.openTrips, 2);
  r = res(); await h(post({ action: 'set_active', id: D1, active: true }), r);
  assert.equal(s.db.drivers[0].active, true);
  assert.equal(s.db.auth[0].ban_duration, 'none');
});

test('livreurs : changement de numéro → aussi sur le compte de connexion', async () => {
  const s = fakeStore(); const h = driversHandler({ env: ENV, store: s, sms: smsOff });
  await h(post({ action: 'create', name: 'א', phone: '0501234567' }), res());
  const r = res(); await h(post({ action: 'update', id: D1, name: 'אבי', phone: '052-765-4321' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(s.db.drivers[0].phone, '+972527654321');
  assert.equal(s.db.drivers[0].name, 'אבי');
  assert.equal(s.db.auth[0].phone, '972527654321');
});

test('notification : brouillon → refusée ; aucun fournisseur SMS → « not_configured » enregistré, rien d\'envoyé', async () => {
  const s = fakeStore(); const h = driversHandler({ env: ENV, store: s, sms: smsOff });
  await h(post({ action: 'create', name: 'א', phone: '0501234567' }), res());
  s.db.trips.push({ id: T1, driver_id: D1, published_at: null });
  let r = res(); await h(post({ action: 'notify', trip_id: T1 }), r);
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'not_published');
  assert.equal(s.db.notes.length, 0, 'jamais de notification pour un brouillon');
  s.db.trips[0].published_at = '2026-11-01T08:00:00Z';
  r = res(); await h(post({ action: 'notify', trip_id: T1 }), r);
  assert.equal(r.body.status, 'not_configured');
  assert.equal(s.db.notes[0].status, 'not_configured');
  assert.equal(s.db.events[0].kind, 'notified');
});

test('notification : envoyée avec seulement un lien ; un échec du fournisseur est enregistré', async () => {
  const s = fakeStore(), sent = [];
  await driversHandler({ env: ENV, store: s, sms: smsOff })(post({ action: 'create', name: 'א', phone: '0501234567' }), res());
  s.db.trips.push({ id: T1, driver_id: D1, published_at: '2026-11-01T08:00:00Z', name: 'מסלול נתניה' });
  let r = res(); await driversHandler({ env: ENV, store: s, sms: smsOn(sent) })(post({ action: 'notify', trip_id: T1 }), r);
  assert.equal(r.body.status, 'sent');
  assert.equal(sent[0].to, '+972501234567');
  assert.ok(sent[0].body.includes('/driver'));
  assert.ok(!sent[0].body.includes('נתניה'), 'pas de nom de tournée ni de client dans le SMS');
  r = res(); await driversHandler({ env: ENV, store: s, sms: smsOn([], 'sms_failed: 21211') })(post({ action: 'notify', trip_id: T1 }), r);
  assert.equal(r.body.status, 'failed');
  assert.equal(s.db.notes[1].status, 'failed');
});

test('notification : livreur désactivé → refusée', async () => {
  const s = fakeStore(); const h = driversHandler({ env: ENV, store: s, sms: smsOff });
  await h(post({ action: 'create', name: 'א', phone: '0501234567', active: false }), res());
  s.db.trips.push({ id: T1, driver_id: D1, published_at: '2026-11-01T08:00:00Z' });
  const r = res(); await h(post({ action: 'notify', trip_id: T1 }), r);
  assert.equal(r.body.error, 'driver_inactive');
});

// ---------- SMS de connexion (crochet Supabase) ----------
const SECRET_B64 = Buffer.from('cle-de-test-fictive-32-octets!!!').toString('base64');
const SECRET = 'v1,whsec_' + SECRET_B64;
function signedReq(payload, { secretB64 = SECRET_B64, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(payload), id = 'msg_1';
  const sig = crypto.createHmac('sha256', Buffer.from(secretB64, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST'; req.headers = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': 'v1,' + sig };
  return req;
}
const HOOK_ENV = { SUPABASE_SECRET_KEY: 'x', SMS_HOOK_SECRET: SECRET };
const activeDriver = { id: D1, phone: '+972501234567', active: true, user_id: 'auth-d' };

test('crochet SMS : signature vérifiée (bonne, fausse, trop ancienne)', () => {
  const raw = '{"a":1}', id = 'm', ts = 1000;
  const sig = crypto.createHmac('sha256', Buffer.from(SECRET_B64, 'base64')).update(`${id}.${ts}.${raw}`).digest('base64');
  const h = { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': 'v1,' + sig };
  assert.equal(verifyStandardWebhook(raw, h, SECRET, 1000), true);
  assert.equal(verifyStandardWebhook(raw, h, 'v1,whsec_' + Buffer.from('autre').toString('base64') + '|' + SECRET, 1000), true, 'plusieurs secrets');
  assert.equal(verifyStandardWebhook(raw + ' ', h, SECRET, 1000), false);
  assert.equal(verifyStandardWebhook(raw, h, SECRET, 1000 + 301), false);
  assert.equal(verifyStandardWebhook(raw, Object.assign({}, h, { 'webhook-signature': 'v1,AAAA' }), SECRET, 1000), false);
});

test('crochet SMS : livreur actif → le code part à son numéro', async () => {
  const sent = [], s = fakeStore({ async driverByUser() { return activeDriver; } }), r = res();
  await smsHookHandler({ env: HOOK_ENV, store: s, sms: smsOn(sent) })(signedReq({ user: { id: 'auth-d', phone: '972501234567' }, sms: { otp: '482913' } }), r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, {});
  assert.equal(sent[0].to, '+972501234567');
  assert.ok(sent[0].body.includes('482913'));
});

test('crochet SMS : désactivé, bloqué ou inconnu → aucun SMS, message relayé à l\'écran', async () => {
  const cases = [
    [{ async driverByUser() { return Object.assign({}, activeDriver, { active: false }); } }, { id: 'auth-d', phone: '972501234567' }, 'driver_inactive'],
    [{ async driverByUser() { return activeDriver; } }, { id: 'auth-d', phone: '972501234567', banned_until: '2999-01-01T00:00:00Z' }, 'driver_inactive'],
    [{ async driverByUser() { return null; } }, { id: 'x', phone: '972501234567' }, 'driver_unknown'],
    [{ async driverByUser() { return activeDriver; } }, { id: 'auth-d', phone: '972529999999' }, 'driver_unknown']
  ];
  for (const [over, user, msg] of cases) {
    const sent = [], r = res();
    await smsHookHandler({ env: HOOK_ENV, store: fakeStore(over), sms: smsOn(sent) })(signedReq({ user, sms: { otp: '1' } }), r);
    assert.equal(r.statusCode, 200, 'Supabase relaie le message seulement avec un statut 200');
    assert.equal(r.body.error.message, msg);
    assert.equal(sent.length, 0);
  }
});

test('crochet SMS : fournisseur pas configuré ou en panne → erreur claire, jamais un faux succès', async () => {
  let r = res();
  await smsHookHandler({ env: HOOK_ENV, store: fakeStore({ async driverByUser() { return activeDriver; } }), sms: smsOff })(signedReq({ user: { id: 'auth-d', phone: '972501234567' }, sms: { otp: '1' } }), r);
  assert.equal(r.body.error.message, 'sms_not_configured');
  r = res();
  await smsHookHandler({ env: HOOK_ENV, store: fakeStore({ async driverByUser() { return activeDriver; } }), sms: smsOn([], 'sms_failed: 500'), log() {} })(signedReq({ user: { id: 'auth-d', phone: '972501234567' }, sms: { otp: '1' } }), r);
  assert.equal(r.body.error.message, 'sms_send_failed');
});

test('crochet SMS : requête non signée ou mauvais secret → 401', async () => {
  const r = res();
  await smsHookHandler({ env: HOOK_ENV, store: fakeStore(), sms: smsOff, log() {} })(signedReq({ user: { id: 'a' }, sms: { otp: '1' } }, { secretB64: Buffer.from('pirate').toString('base64') }), r);
  assert.equal(r.statusCode, 401);
});

test('finances : un livreur connecté ne peut pas lancer la synchro Morning (403)', async () => {
  const r = res(), calls = [];
  const env = { MORNING_CLIENT_ID: 'id', MORNING_CLIENT_SECRET: 's', SUPABASE_SECRET_KEY: 'k' };
  const store = { async userFromToken() { return { id: 'auth-d' }; }, async isStaff() { return false; }, async getState() { return null; } };
  await syncHandler({ env, store, sync: { async syncAll() { calls.push(1); } } })({ headers: { authorization: 'Bearer driver' }, query: {} }, r);
  assert.equal(r.statusCode, 403);
  assert.equal(calls.length, 0);
});
