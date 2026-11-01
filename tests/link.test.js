// Tests de l'accès par lien privé (données fictives).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../delivery-core.js');
const { linkHandler, hashToken } = require('../api/_lib/link.js');

test('heure d\'Israël → UTC (hiver +2, été +3), et retour', () => {
  assert.equal(D.ilToUtcISO('2026-11-02T18:00'), '2026-11-02T16:00:00.000Z');
  assert.equal(D.ilToUtcISO('2026-07-01T18:00'), '2026-07-01T15:00:00.000Z');
  assert.equal(D.utcToIlInput('2026-11-02T16:00:00Z'), '2026-11-02T18:00');
  assert.equal(D.utcToIlInput('2026-07-01T15:00:00Z'), '2026-07-01T18:00');
  assert.equal(D.ilToUtcISO('bientôt'), null);
});
test('état d\'un lien : actif, expiré, révoqué, inactif (tournée en brouillon ou autre livreur)', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const L = { driver_id: 'd1', expires_at: '2026-11-01T20:00:00Z', revoked_at: null };
  const T = { publishedAt: 'x', driverId: 'd1' };
  assert.equal(D.linkState(L, T, now), 'active');
  assert.equal(D.linkState(Object.assign({}, L, { expires_at: '2026-11-01T11:00:00Z' }), T, now), 'expired');
  assert.equal(D.linkState(Object.assign({}, L, { revoked_at: 'x' }), T, now), 'revoked');
  assert.equal(D.linkState(L, { publishedAt: '', driverId: 'd1' }, now), 'inactive');
  assert.equal(D.linkState(L, { publishedAt: 'x', driverId: 'd2' }, now), 'inactive');
  assert.equal(D.linkState(null, T, now), 'none');
  for (const k of Object.keys(D.LINK_STATES)) assert.ok(D.LINK_STATES[k].label && D.LINK_STATES[k].icon, k);
});
test('clé lue après # seulement, format strict', () => {
  const k = 'A'.repeat(43);
  assert.equal(D.linkTokenFrom('#t=' + k), k);
  assert.equal(D.linkTokenFrom('#/trip/x&t=' + k), k);
  assert.equal(D.linkTokenFrom('#t=court'), null);
  assert.equal(D.linkTokenFrom('#t=' + k + '<script>'), null);
});

// ---------- serveur ----------
const TOKEN = 'k'.repeat(43), H = hashToken(TOKEN);
const TRIP = '11111111-1111-4111-8111-111111111111', TASK = '22222222-2222-4222-8222-222222222222', ID = '33333333-3333-4333-8333-333333333333';
const JPEG = 'data:image/jpeg;base64,' + Buffer.alloc(300, 7).toString('base64');
function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } }; }
function store(state = 'ok', over = {}) {
  const calls = [], files = {}, removed = [];
  return Object.assign({ calls, files, removed,
    async rpc(name, args) {
      calls.push([name, Object.assign({}, args)]);
      assert.equal(args.p_hash, H, 'le serveur n\'envoie que l\'empreinte');
      if (state !== 'ok') { if (name === 'link_resolve') return { status: state }; throw new Error(`POST rpc/${name} : 400 {"message":"link_${state}"}`); }
      if (name === 'link_resolve') return { status: 'ok', link_id: 'L1', trip_id: TRIP, driver_id: 'D1', expires_at: 'x' };
      if (name === 'link_trip') return { link: { expires_at: 'x', trip_id: TRIP }, trip: { id: TRIP, stops: [] } };
      if (name === 'link_set_status') return { id: args.p_task, delivery_status: args.p_status };
      if (name === 'link_add_proof') return { id: 'p1', path: args.p_path, received_at: 'now' };
      if (name === 'link_paths') return args.p_paths.filter(p => p.startsWith(TRIP)).map(p => ({ path: p, bucket: 'delivery-proofs' }));
    },
    async uploadFile(p, b) { files[p] = b; },
    async removeFiles(bucket, ps) { removed.push(...ps); },
    async proofByPath() { return null; },
    async signUrls(bucket, ps) { return ps.map(p => ({ path: p, url: 'https://signed/' + p })); }
  }, over);
}
const call = async (s, body, token = TOKEN, logs = []) => { const r = res(); await linkHandler({ env: { SUPABASE_SECRET_KEY: 'k' }, store: s, log: (...a) => logs.push(a.join(' ')) })({ method: 'POST', headers: token ? { 'x-link-token': token } : {}, body }, r); return r; };

test('lien : sans clé ou clé mal formée → 401 ; rien n\'est demandé à la base', async () => {
  const s = store();
  assert.equal((await call(s, { action: 'trip' }, null)).statusCode, 401);
  assert.equal((await call(s, { action: 'trip' }, 'trop-court')).statusCode, 401);
  assert.equal(s.calls.length, 0);
});
test('lien valide : la tournée du lien', async () => {
  const r = await call(store(), { action: 'trip' });
  assert.equal(r.statusCode, 200); assert.equal(r.body.trip.id, TRIP);
});
test('lien expiré / révoqué / inactif → 410 sur consultation, statut, photo et signature', async () => {
  for (const st of ['expired', 'revoked', 'inactive']) {
    for (const body of [{ action: 'trip' }, { action: 'status', task_id: TASK, status: 'delivered' }, { action: 'urls', paths: [TRIP + '/x'] }]) {
      const r = await call(store(st), body);
      assert.equal(r.statusCode, 410, st + ' ' + body.action); assert.equal(r.body.error, 'link_' + st);
    }
    const s = store(st);
    const p = await call(s, { action: 'proof', task_id: TASK, id: ID, image: JPEG });
    assert.equal(p.statusCode, 410); assert.equal(Object.keys(s.files).length, 0, 'aucun fichier déposé');
    const g = await call(store(st), { action: 'sign', request_id: ID, task_id: TASK, morning_id: ID, sha256: 'a'.repeat(64), receiver_name: 'אבי', strokes: [], signature_png: '', block_png: '' });
    assert.equal(g.statusCode, 410);
  }
});
test('photo : déposée dans la tournée DU LIEN, puis enregistrée', async () => {
  const s = store(); const r = await call(s, { action: 'proof', task_id: TASK, id: ID, image: JPEG, note: 'חתם' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(Object.keys(s.files), [`${TRIP}/${TASK}/${ID}.jpg`]);
  assert.equal(r.body.proof.id, 'p1');
});
test('photo : lien expiré entre le dépôt et l\'enregistrement → fichier retiré, pas de faux « reçu »', async () => {
  const s = store('ok', {}); const orig = s.rpc;
  s.rpc = async (n, a) => { if (n === 'link_add_proof') throw new Error('POST rpc/link_add_proof : 400 {"message":"link_expired"}'); return orig(n, a); };
  const r = await call(s, { action: 'proof', task_id: TASK, id: ID, image: JPEG });
  assert.equal(r.statusCode, 410);
  assert.deepEqual(s.removed, [`${TRIP}/${TASK}/${ID}.jpg`]);
});
test('arrêt d\'une autre tournée (identifiant changé) → refusé par la base, réponse 403', async () => {
  const s = store(); const orig = s.rpc;
  s.rpc = async (n, a) => { if (n === 'link_set_status') throw new Error('POST rpc/link_set_status : 404 {"message":"not_found"}'); return orig(n, a); };
  const r = await call(s, { action: 'status', task_id: TASK, status: 'delivered' });
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, 'not_found');
});
test('fichiers : liens temporaires seulement pour les chemins autorisés par la base', async () => {
  const r = await call(store(), { action: 'urls', paths: [TRIP + '/a/b.jpg', 'autre-tournee/a/b.jpg'] });
  assert.deepEqual(r.body.urls.map(u => u.path), [TRIP + '/a/b.jpg']);
});
test('la clé n\'apparaît jamais dans les journaux', async () => {
  const logs = [], s = store(); s.rpc = async () => { throw new Error('panne'); };
  await call(s, { action: 'trip' }, TOKEN, logs);
  assert.ok(logs.length); assert.ok(!logs.join(' ').includes(TOKEN)); assert.ok(!logs.join(' ').includes(H));
});
