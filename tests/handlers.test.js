// Tests des points d'entrée serveur : qui a le droit de lancer une synchro, et les alertes Morning.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { syncHandler, webhookHandler, cleanEnv } = require('../api/_lib/handlers.js');

test('clés du serveur : espaces et retours à la ligne collés par erreur sont ignorés', () => {
  const env = cleanEnv({ MORNING_WEBHOOK_SECRET: ' hook123\r\n', CRON_SECRET: 'cron123\n', MORNING_CLIENT_ID: '\tid ', AUTRE: ' x ' });
  assert.equal(env.MORNING_WEBHOOK_SECRET, 'hook123');
  assert.equal(env.CRON_SECRET, 'cron123');
  assert.equal(env.MORNING_CLIENT_ID, 'id');
  assert.equal(env.AUTRE, undefined, 'seules les clés du branchement Morning sont reprises');
});

const ENV = { MORNING_CLIENT_ID: 'id', MORNING_CLIENT_SECRET: 'secret', SUPABASE_SECRET_KEY: 'sb_secret_x', CRON_SECRET: 'cron123', MORNING_WEBHOOK_SECRET: 'hook123' };
const UUID = '42f88247-b0a5-49dc-af74-ddb1a77b3f5a';

function res() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
function deps(over = {}) {
  const calls = [];
  return {
    calls,
    store: Object.assign({
      async userFromToken(t) { return t === 'user-ok' ? { id: 'u1' } : null; },
      async clientSyncedSince() { return false; },
      async getState() { return { last_run: '2000-01-01T00:00:00Z' }; },
    }, over.store || {}),
    sync: Object.assign({
      async syncAll(opts) { calls.push(['syncAll', opts.customerId || null]); return { clients: 1, documents: 2, pdfs: 0, conflicts: [] }; },
      async onDocumentCreated(id) { calls.push(['doc', id]); return { stored: true }; },
    }, over.sync || {}),
  };
}

test('synchro : serveur pas configuré → 503', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: {}, ...d })({ headers: {}, query: {} }, r);
  assert.equal(r.statusCode, 503);
  assert.deepEqual(d.calls, []);
});

test('synchro : sans connexion → refusé (401)', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: {}, query: {} }, r);
  assert.equal(r.statusCode, 401);
  assert.deepEqual(d.calls, []);
});

test('synchro : faux jeton → refusé (401)', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer pirate' }, query: {} }, r);
  assert.equal(r.statusCode, 401);
});

test('synchro : la tâche de nuit (secret cron) lance la synchro complète', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer cron123' }, query: {} }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(d.calls, [['syncAll', null]]);
});

test('synchro : utilisateur connecté + fiche client → synchro de ce client seulement', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer user-ok' }, query: { customer: UUID } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(d.calls, [['syncAll', UUID]]);
});

test('synchro : identifiant de fiche invalide → 400', async () => {
  const d = deps(); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer user-ok' }, query: { customer: "x' or 1=1" } }, r);
  assert.equal(r.statusCode, 400);
  assert.deepEqual(d.calls, []);
});

test('synchro : fiche déjà mise à jour il y a moins de 2 minutes → rien à faire', async () => {
  const d = deps({ store: { async clientSyncedSince() { return true; } } }); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer user-ok' }, query: { customer: UUID } }, r);
  assert.equal(r.body.skipped, true);
  assert.deepEqual(d.calls, []);
});

test('synchro complète demandée par un utilisateur : au plus une fois toutes les 5 minutes', async () => {
  const d = deps({ store: { async getState() { return { last_run: new Date().toISOString() }; } } }); const r = res();
  await syncHandler({ env: ENV, ...d })({ headers: { authorization: 'Bearer user-ok' }, query: {} }, r);
  assert.equal(r.body.skipped, true);
  assert.deepEqual(d.calls, []);
});

test('synchro : erreur → 500 sans détail technique', async () => {
  const d = deps({ sync: { async syncAll() { throw new Error('clé secrète xyz'); } } }); const r = res();
  await syncHandler({ env: ENV, ...d, log: () => {} })({ headers: { authorization: 'Bearer cron123' }, query: {} }, r);
  assert.equal(r.statusCode, 500);
  assert.ok(!JSON.stringify(r.body).includes('xyz'));
});

function hookReq(bodyStr, { secret = 'hook123', topic = 'document/created', sig } = {}) {
  const raw = Buffer.from(bodyStr);
  const req = Readable.from([raw]);
  req.method = 'POST';
  req.headers = { 'x-webhook-topic': topic, 'x-webhook-signature': sig !== undefined ? sig : crypto.createHmac('sha256', secret).update(raw).digest('hex') };
  return req;
}

test('alerte Morning : mauvaise signature → refusée (401), rien n\'est fait', async () => {
  const d = deps(); const r = res();
  await webhookHandler({ env: ENV, ...d, log: () => {} })(hookReq('{"id":"d1"}', { secret: 'autre' }), r);
  assert.equal(r.statusCode, 401);
  assert.deepEqual(d.calls, []);
});

test('alerte Morning : document créé → mise à jour du client', async () => {
  const d = deps(); const r = res();
  await webhookHandler({ env: ENV, ...d })(hookReq('{"id":"d1","type":305}'), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(d.calls, [['doc', 'd1']]);
});

test('alerte Morning : autre type d\'événement → ignoré', async () => {
  const d = deps(); const r = res();
  await webhookHandler({ env: ENV, ...d })(hookReq('{"id":"c1"}', { topic: 'client/created' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(d.calls, []);
});

test('alerte Morning : erreur interne → répond quand même 200 (sinon Morning coupe l\'alerte après 15 échecs)', async () => {
  const d = deps({ sync: { async onDocumentCreated() { throw new Error('panne'); } } }); const r = res();
  await webhookHandler({ env: ENV, ...d, log: () => {} })(hookReq('{"id":"d1"}'), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, false);
});

test('alerte Morning : secret non configuré → refusée', async () => {
  const d = deps(); const r = res();
  await webhookHandler({ env: { ...ENV, MORNING_WEBHOOK_SECRET: '' }, ...d, log: () => {} })(hookReq('{"id":"d1"}'), r);
  assert.equal(r.statusCode, 401);
});
