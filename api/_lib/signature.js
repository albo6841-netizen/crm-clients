// Étape 2 : réception d'une signature au doigt LIÉE À UN DOCUMENT PRÉCIS.
// Le livreur envoie : identifiant d'envoi, arrêt, document Morning, empreinte SHA-256 du fichier affiché,
// nom du réceptionnaire, tracé (points 0..1) et deux images (la signature seule, le bloc « reçu signé » en hébreu).
// Le serveur vérifie tout, garde une copie figée du fichier (octets identiques à l'empreinte),
// fabrique un exemplaire signé (document + page de signature) et n'enregistre la signature qu'ensuite.
// « התקבל » n'est affiché au livreur qu'après cette réponse.
const crypto = require('node:crypto');
const { PDFDocument, StandardFonts, rgb } = require('./vendor/pdf-lib.min.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/;
const sha256hex = buf => crypto.createHash('sha256').update(buf).digest('hex');

const bearerOf = req => {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : null;
  if (raw == null) { const chunks = []; for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); raw = Buffer.concat(chunks).toString('utf8'); }
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return null; }
}
// Image PNG envoyée en « data:image/png;base64,… » ; renvoie les octets ou null
function pngFromDataUrl(s, max) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length < 60 || b.length > max || b.readUInt32BE(0) !== 0x89504e47) return null;
  return b;
}
// Tracé : traits de points normalisés (0..1), assez d'encre pour une vraie signature
function validStrokes(s) {
  if (!Array.isArray(s) || !s.length || s.length > 300) return false;
  let n = 0, inked = false;
  for (const st of s) {
    if (!Array.isArray(st)) return false;
    for (const p of st) {
      if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || !(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)) return false;
      n++;
    }
    if (st.length >= 3) inked = true;
  }
  return inked && n <= 20000;
}
const cleanName = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 100);
const ilTime = d => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);

// Exemplaire signé : toutes les pages du document d'origine + une page « reçu signé ».
// Les textes hébreux sont dans l'image faite par le téléphone ; le serveur ajoute ses données (ASCII) qui font foi.
async function buildSignedPdf(original, blockPng, lines) {
  const pdf = await PDFDocument.load(original);
  const img = await pdf.embedPng(blockPng);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const W = 595.28, H = 841.89, m = 40, w = W - 2 * m, h = Math.min(img.height * w / img.width, H * 0.55);
  const page = pdf.addPage([W, H]);
  page.drawImage(img, { x: m, y: H - m - h, width: h * img.width / img.height, height: h });
  let y = H - m - h - 28;
  for (const line of lines) { page.drawText(line, { x: m, y, size: 9, font, color: rgb(0.16, 0.24, 0.23) }); y -= 14; }
  pdf.setProducer('Masloulim'); pdf.setCreator('Masloulim - espace livreurs');
  return Buffer.from(await pdf.save());
}

const pick = r => ({ id: r.id, request_id: r.request_id, receiver_name: r.receiver_name, signed_at: r.signed_at, signed_pdf_path: r.signed_pdf_path, image_path: r.image_path, document_sha256: r.document_sha256 });

// Cœur commun : livreur connecté (téléphone) OU accès par lien (limité à une tournée).
// driver : { id, active } ; onlyTrip : la tournée du lien (sinon null) ; linkId : le lien utilisé (historique) ;
// recheck() : revérifie le lien juste avant d'enregistrer (il a pu expirer pendant l'envoi).
async function signCore({ store, driver, onlyTrip = null, linkId = null, recheck = null, b, log = console.error, now = () => new Date() }) {
  const fail = (status, error) => ({ status, body: { ok: false, error } });
  if (!b || typeof b !== 'object') return fail(400, 'bad_request');
  const receiver = cleanName(b.receiver_name), sha = String(b.sha256 || '').toLowerCase();
  const sigPng = pngFromDataUrl(b.signature_png, 400 * 1024), blockPng = pngFromDataUrl(b.block_png, 2 * 1024 * 1024);
  if (![b.request_id, b.task_id, b.morning_id].every(x => UUID_RE.test(String(x || ''))) || !HEX64.test(sha)) return fail(400, 'bad_request');
  if (receiver.length < 2) return fail(400, 'receiver_required');
  if (!validStrokes(b.strokes) || !sigPng || !blockPng) return fail(400, 'signature_required');
  if (!driver || !driver.active) return fail(403, 'not_driver');
  // même envoi déjà reçu (réponse perdue, nouvel essai) : on renvoie la même signature
  const prev = await store.signatureByRequest(b.request_id);
  if (prev) {
    if (prev.driver_id !== driver.id || prev.task_id !== b.task_id || prev.morning_id !== b.morning_id) return fail(409, 'request_conflict');
    return { status: 200, body: { ok: true, signature: pick(prev) } };
  }
  const stop = await store.stopForDriver(b.task_id, driver.id);           // arrêt d'une tournée PUBLIÉE de CE livreur
  if (!stop || (onlyTrip && stop.trip_id !== onlyTrip)) return fail(403, 'not_found');   // lien : SA tournée seulement
  const doc = await store.linkedDoc(b.task_id, b.morning_id);            // document rattaché à CET arrêt par l'équipe
  if (!doc || !doc.pdf_path) return fail(404, 'doc_not_linked');
  if (await store.signatureByDoc(b.task_id, b.morning_id)) return fail(409, 'already_signed');
  const original = await store.downloadPdf(doc.pdf_path);
  if (sha256hex(original) !== sha) return fail(409, 'document_changed');  // le fichier a changé depuis l'affichage
  const at = now();
  const base = `signatures/${stop.trip_id}/${stop.id}/${b.request_id}/`;
  const written = [];
  await store.uploadFile(base + 'original.pdf', original, 'application/pdf'); written.push(base + 'original.pdf');
  await store.uploadFile(base + 'signature.png', sigPng, 'image/png'); written.push(base + 'signature.png');
  let signedPath = null;
  try {
    const signed = await buildSignedPdf(original, blockPng, [
      'Signed copy - Masloulim delivery space. The original document file is kept unchanged.',
      'Received by server: ' + ilTime(at) + ' (Asia/Jerusalem)' + (linkId ? '   Access: private link of the assigned driver' : ''),
      'Document: Morning type ' + doc.type + ' no. ' + (doc.number || '-') + ' (id ' + doc.morning_id + ')',
      'Original file SHA-256: ' + sha,
      'Delivery stop: ' + stop.id + '   Request: ' + b.request_id
    ]);
    await store.uploadFile(base + 'signed.pdf', signed, 'application/pdf');
    signedPath = base + 'signed.pdf'; written.push(signedPath);
  } catch (e) { log('signature exemplaire signé', e && e.message); }
  // lien : expiré ou désactivé pendant l'envoi → rien d'enregistré, fichiers retirés
  if (recheck && !(await recheck())) {
    if (store.removeFiles) await store.removeFiles('delivery-proofs', written).catch(() => {});
    return fail(410, 'link_expired');
  }
  const row = await store.insertSignature({
    request_id: b.request_id, task_id: stop.id, trip_id: stop.trip_id, customer_id: stop.customer_id || null, driver_id: driver.id,
    morning_id: doc.morning_id, document_number: doc.number || null, document_sha256: sha, receiver_name: receiver, strokes: b.strokes,
    original_pdf_path: base + 'original.pdf', signed_pdf_path: signedPath, image_path: base + 'signature.png',
    client_signed_at: b.client_time && !isNaN(Date.parse(b.client_time)) ? new Date(b.client_time).toISOString() : null,
    signed_at: at.toISOString(), link_id: linkId
  });
  if (!row) return fail(409, 'already_signed');
  return { status: 200, body: { ok: true, signature: pick(row) } };
}

// POST /api/driver-sign  (livreur connecté par téléphone)
function driverSignHandler({ env, store, log = console.error, now = () => new Date() }) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    if (!env.SUPABASE_SECRET_KEY || !store) return res.status(503).json({ ok: false, error: 'not_configured' });
    const bearer = bearerOf(req);
    const user = bearer ? await store.userFromToken(bearer) : null;
    if (!user) return res.status(401).json({ ok: false, error: 'login_required' });
    const b = await readJson(req);
    try {
      const driver = await store.driverByUser(user.id);
      const r = await signCore({ store, driver, b, log, now });
      return res.status(r.status).json(r.body);
    } catch (e) {
      log('driver-sign', e && e.message);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  };
}

module.exports = { driverSignHandler, signCore, readJson, buildSignedPdf, validStrokes, pngFromDataUrl, sha256hex };
