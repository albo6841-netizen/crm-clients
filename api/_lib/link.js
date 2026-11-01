// Accès temporaire à UNE tournée par lien privé (sans connexion par téléphone).
// La clé du lien arrive dans l'en-tête « x-link-token » (jamais dans l'adresse : pas de trace dans les journaux).
// Le serveur n'utilise que son empreinte SHA-256 ; la base (fonctions link_*) revérifie le lien à CHAQUE appel :
// actif, non expiré, attribué au livreur actuel de la tournée, tournée envoyée.
const crypto = require('node:crypto');
const { signCore, readJson } = require('./signature.js');

const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hashToken = t => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const LINK_ERRORS = { invalid: [401, 'link_invalid'], revoked: [410, 'link_revoked'], expired: [410, 'link_expired'], inactive: [410, 'link_inactive'] };
// Erreur venant de la base → réponse claire (sans jamais renvoyer ni journaliser la clé)
function fromDbError(e) {
  const m = String((e && e.message) || '');
  const k = (/link_(invalid|revoked|expired|inactive)/.exec(m) || [])[1];
  if (k) return LINK_ERRORS[k];
  for (const code of ['not_found', 'bad_status', 'note_required', 'already_validated', 'bad_path', 'file_missing', 'stop_unavailable']) if (m.includes(code)) return [code === 'not_found' ? 403 : 409, code];
  return null;
}
// photo envoyée en « data:image/jpeg;base64,… »
function imageFromDataUrl(s, max) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  return buf.length > 100 && buf.length <= max ? { mime: m[1], buf } : null;
}

function linkHandler({ env, store, log = console.error, now = () => new Date() }) {
  return async (req, res) => {
    const send = (status, body) => res.status(status).json(body);
    const fail = (status, error) => send(status, { ok: false, error });
    if (req.method !== 'POST') return res.status(405).end();
    if (!env.SUPABASE_SECRET_KEY || !store) return fail(503, 'not_configured');
    const token = String((req.headers && req.headers['x-link-token']) || '');
    if (!TOKEN_RE.test(token)) return fail(401, 'link_invalid');
    const hash = hashToken(token);
    const b = await readJson(req);
    if (!b || typeof b !== 'object') return fail(400, 'bad_request');
    const action = String(b.action || '');
    try {
      if (action === 'trip') {
        const data = await store.rpc('link_trip', { p_hash: hash });
        return send(200, Object.assign({ ok: true }, data));
      }
      if (action === 'seen') {          // le téléphone a affiché cette version de la tournée (étape 2)
        const v = Number(b.version);
        if (!Number.isInteger(v) || v < 1 || v > 100000) return fail(400, 'bad_request');
        await store.rpc('link_trip_seen', { p_hash: hash, p_version: v });
        return send(200, { ok: true });
      }
      if (action === 'status') {
        if (!UUID_RE.test(String(b.task_id || ''))) return fail(400, 'bad_request');
        const data = await store.rpc('link_set_status', { p_hash: hash, p_task: b.task_id, p_status: b.status, p_note: b.note == null ? null : String(b.note) });
        return send(200, { ok: true, result: data });
      }
      if (action === 'urls') {
        const paths = Array.isArray(b.paths) ? b.paths.filter(p => typeof p === 'string' && p.length < 300).slice(0, 60) : [];
        if (!paths.length) return send(200, { ok: true, urls: [] });
        const allowed = await store.rpc('link_paths', { p_hash: hash, p_paths: paths });   // seulement les fichiers de SA tournée
        const urls = [];
        for (const bucket of ['delivery-proofs', 'morning-pdf']) {
          const list = (allowed || []).filter(x => x.bucket === bucket).map(x => x.path);
          if (list.length) urls.push(...await store.signUrls(bucket, list, Math.min(600, Math.max(30, +b.expires || 120))));
        }
        return send(200, { ok: true, urls });
      }
      if (action === 'proof') {
        const img = imageFromDataUrl(b.image, 12 * 1024 * 1024);
        if (!UUID_RE.test(String(b.task_id || '')) || !UUID_RE.test(String(b.id || '')) || !img) return fail(400, 'bad_request');
        const link = await store.rpc('link_resolve', { p_hash: hash });                     // vérifié AVANT tout dépôt
        if (!link || link.status !== 'ok') { const e = LINK_ERRORS[link && link.status] || LINK_ERRORS.invalid; return fail(e[0], e[1]); }
        const path = `${link.trip_id}/${b.task_id}/${b.id}.jpg`;
        let uploaded = false;
        try {
          await store.uploadFile(path, img.buf, img.mime); uploaded = true;
          const row = await store.rpc('link_add_proof', { p_hash: hash, p_task: b.task_id, p_path: path, p_note: b.note || null,
            p_captured_at: b.captured_at && !isNaN(Date.parse(b.captured_at)) ? b.captured_at : null, p_mime: img.mime, p_bytes: img.buf.length });
          return send(200, { ok: true, proof: row });
        } catch (e) {
          // lien expiré pendant l'envoi, ou arrêt d'une autre tournée : rien d'enregistré, fichier retiré
          if (uploaded && store.removeFiles) {
            const known = await store.proofByPath(path).catch(() => null);
            if (!known) await store.removeFiles('delivery-proofs', [path]).catch(() => {});
          }
          throw e;
        }
      }
      if (action === 'sign') {
        const link = await store.rpc('link_resolve', { p_hash: hash });
        if (!link || link.status !== 'ok') { const e = LINK_ERRORS[link && link.status] || LINK_ERRORS.invalid; return fail(e[0], e[1]); }
        const r = await signCore({ store, driver: { id: link.driver_id, active: true }, onlyTrip: link.trip_id, linkId: link.link_id, b, log, now,
          recheck: async () => { const x = await store.rpc('link_resolve', { p_hash: hash }); return !!x && x.status === 'ok'; } });
        return send(r.status, r.body);
      }
      return fail(400, 'bad_action');
    } catch (e) {
      const mapped = fromDbError(e);
      if (mapped) return fail(mapped[0], mapped[1]);
      log('link', action, e && e.message);       // jamais la clé ni les en-têtes
      return fail(500, 'server_error');
    }
  };
}

module.exports = { linkHandler, hashToken };
