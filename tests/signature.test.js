// Tests de l'étape 2 (signature liée à un document précis) — données fictives.
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('../api/_lib/vendor/pdf-lib.min.js');
const { driverSignHandler, buildSignedPdf, validStrokes, pngFromDataUrl, sha256hex } = require('../api/_lib/signature.js');

const U = n => '0000000' + n + '-0000-4000-8000-00000000000' + n;
const REQ = U(1), TASK = U(2), DOC = U(3), TRIP = U(4), DRV = U(5);
// plus petite image PNG valide (1×1)
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STROKES = [[{ x: .1, y: .5 }, { x: .3, y: .2 }, { x: .5, y: .6 }, { x: .8, y: .3 }]];
let ORIGINAL;
test.before(async () => { const d = await PDFDocument.create(); d.addPage([300, 400]); d.addPage([300, 400]); ORIGINAL = Buffer.from(await d.save()); });

function res() { return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } }; }
function store(over = {}) {
  const files = {}, rows = [];
  return Object.assign({
    files, rows,
    async userFromToken(t) { return t === 'drv' ? { id: 'auth-a' } : t === 'other' ? { id: 'auth-b' } : null; },
    async driverByUser(u) { return u === 'auth-a' ? { id: DRV, active: true } : u === 'auth-b' ? { id: U(6), active: true } : null; },
    async signatureByRequest(id) { return rows.find(r => r.request_id === id) || null; },
    async stopForDriver(t, d) { return t === TASK && d === DRV ? { id: TASK, trip_id: TRIP, customer_id: null } : null; },
    async linkedDoc(t, m) { return t === TASK && m === DOC ? { morning_id: DOC, type: 305, number: '20417', pdf_path: 'c/x.pdf' } : null; },
    async signatureByDoc(t, m) { return rows.find(r => r.task_id === t && r.morning_id === m) || null; },
    async downloadPdf() { return ORIGINAL; },
    async uploadFile(p, b) { files[p] = b; },
    async insertSignature(r) { const row = Object.assign({ id: 'sig-' + rows.length }, r); rows.push(row); return row; }
  }, over);
}
const body = (o = {}) => Object.assign({ request_id: REQ, task_id: TASK, morning_id: DOC, sha256: sha256hex(ORIGINAL), receiver_name: '  רונית   כהן ', strokes: STROKES, signature_png: PNG, block_png: PNG, client_time: '2026-11-01T15:35:00Z' }, o);
const call = async (s, b, token = 'drv') => { const r = res(); await driverSignHandler({ env: { SUPABASE_SECRET_KEY: 'k' }, store: s, log() {}, now: () => new Date('2026-11-01T15:35:43Z') })({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: b }, r); return r; };

test('tracé et images : contrôles', () => {
  assert.equal(validStrokes(STROKES), true);
  assert.equal(validStrokes([[{ x: .1, y: .1 }]]), false, 'un point ne suffit pas');
  assert.equal(validStrokes([[{ x: 2, y: .1 }, { x: .1, y: .1 }, { x: .2, y: .2 }]]), false, 'hors cadre');
  assert.equal(validStrokes('x'), false);
  assert.ok(pngFromDataUrl(PNG, 1000));
  assert.equal(pngFromDataUrl('data:image/jpeg;base64,AAAA', 1000), null);
  assert.equal(pngFromDataUrl(PNG, 10), null, 'trop gros');
});

test('exemplaire signé : toutes les pages d\'origine + une page de signature', async () => {
  const PNGbuf = pngFromDataUrl(PNG, 1000);
  const out = await buildSignedPdf(ORIGINAL, PNGbuf, ['Received by server: test']);
  const d = await PDFDocument.load(out);
  assert.equal(d.getPageCount(), 3);
});

test('signature reçue : fichiers figés + exemplaire signé, puis enregistrement lié au document précis', async () => {
  const s = store(); const r = await call(s, body());
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const base = `signatures/${TRIP}/${TASK}/${REQ}/`;
  assert.deepEqual(Object.keys(s.files).sort(), [base + 'original.pdf', base + 'signature.png', base + 'signed.pdf'].sort());
  assert.ok(s.files[base + 'original.pdf'].equals(ORIGINAL), 'copie figée identique octet pour octet');
  const row = s.rows[0];
  assert.equal(row.document_sha256, sha256hex(ORIGINAL));
  assert.equal(row.morning_id, DOC); assert.equal(row.task_id, TASK); assert.equal(row.driver_id, DRV);
  assert.equal(row.receiver_name, 'רונית כהן');
  assert.equal(row.signed_at, '2026-11-01T15:35:43.000Z', 'heure du serveur');
  assert.equal(r.body.signature.signed_pdf_path, base + 'signed.pdf');
});

test('même envoi renvoyé (réponse perdue) : pas de doublon', async () => {
  const s = store();
  await call(s, body());
  const r = await call(s, body());
  assert.equal(r.statusCode, 200);
  assert.equal(s.rows.length, 1);
});

test('document déjà signé avec un autre envoi → refusé', async () => {
  const s = store();
  await call(s, body());
  const r = await call(s, body({ request_id: U(7) }));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'already_signed');
});

test('fichier différent de celui affiché (empreinte) → refusé, rien enregistré', async () => {
  const s = store(); const r = await call(s, body({ sha256: 'a'.repeat(64) }));
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'document_changed');
  assert.equal(s.rows.length, 0); assert.equal(Object.keys(s.files).length, 0);
});

test('accès : non connecté 401, autre livreur 403, document non rattaché 404', async () => {
  assert.equal((await call(store(), body(), null)).statusCode, 401);
  const o = await call(store(), body(), 'other'); assert.equal(o.statusCode, 403);
  const n = await call(store(), body({ morning_id: U(8) })); assert.equal(n.statusCode, 404); assert.equal(n.body.error, 'doc_not_linked');
  const d = await call(store({ async driverByUser() { return { id: DRV, active: false }; } }), body()); assert.equal(d.statusCode, 403);
});

test('saisie incomplète : nom, signature, empreinte', async () => {
  assert.equal((await call(store(), body({ receiver_name: ' a ' }))).body.error, 'receiver_required');
  assert.equal((await call(store(), body({ strokes: [] }))).body.error, 'signature_required');
  assert.equal((await call(store(), body({ signature_png: 'x' }))).body.error, 'signature_required');
  assert.equal((await call(store(), body({ sha256: 'xyz' }))).body.error, 'bad_request');
});

test('panne du stockage → erreur, et la signature n\'est PAS enregistrée (jamais de faux « reçu »)', async () => {
  const s = store({ async uploadFile() { throw new Error('stockage indisponible'); } });
  const r = await call(s, body());
  assert.equal(r.statusCode, 500);
  assert.equal(s.rows.length, 0);
});
