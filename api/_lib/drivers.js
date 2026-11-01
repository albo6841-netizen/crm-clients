// Points d'entrée serveur de l'espace livreurs, séparés de Vercel pour pouvoir les tester.
//  - driversHandler : l'équipe ajoute / modifie / désactive un livreur et envoie la notification « nouvelle tournée »
//  - smsHookHandler : Supabase Auth nous confie l'envoi du SMS de connexion (seulement aux livreurs actifs)
const crypto = require('node:crypto');
const D = require('../../delivery-core.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DRIVER_URL = 'https://crm-clients-il.vercel.app/driver';
const BAN_FOREVER = '876000h';   // ~100 ans : compte désactivé

const bearerOf = req => {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
async function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  const raw = typeof req.body === 'string' ? req.body : (await readRaw(req)).toString('utf8');
  try { return raw ? JSON.parse(raw) : {}; } catch (_) { return null; }
}
const fail = (res, status, error) => res.status(status).json({ ok: false, error });
const cleanName = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 80);

// POST /api/drivers  { action: 'create' | 'update' | 'set_active' | 'notify', ... }   (équipe connectée seulement)
function driversHandler({ env, store, sms, log = console.error }) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    if (!env.SUPABASE_SECRET_KEY || !store) return fail(res, 503, 'not_configured');
    const bearer = bearerOf(req);
    const user = bearer ? await store.userFromToken(bearer) : null;
    if (!user) return fail(res, 401, 'login_required');
    if (!(await store.isStaff(user.id))) return fail(res, 403, 'staff_only');
    const body = await readJson(req);
    if (!body || typeof body !== 'object') return fail(res, 400, 'bad_request');
    try {
      if (body.action === 'create') return await createDriver(body, res);
      if (body.action === 'update') return await updateDriver(body, res);
      if (body.action === 'set_active') return await setActive(body, res);
      if (body.action === 'notify') return await notify(body, res, user);
      return fail(res, 400, 'bad_action');
    } catch (e) {
      log('drivers', body.action, e && e.message);
      return fail(res, 500, 'server_error');
    }
  };

  async function createDriver(body, res) {
    const name = cleanName(body.name), phone = D.normalizePhone(body.phone);
    const active = body.active !== false;
    if (!name) return fail(res, 400, 'name_required');
    if (!phone) return fail(res, 400, 'bad_phone');
    if (await store.driverByPhone(phone)) return fail(res, 409, 'phone_exists');
    const digits = phone.slice(1);
    let uid = await store.authUserByPhone(digits), created = false;
    if (uid) {
      if (await store.isStaff(uid)) return fail(res, 409, 'phone_is_staff');
      if (await store.driverByUser(uid)) return fail(res, 409, 'phone_exists');
    } else {
      uid = await store.createAuthUser(digits); created = true;
    }
    let driver;
    try {
      driver = await store.insertDriver({ name, phone, active, user_id: uid });
    } catch (e) {
      if (created) await store.deleteAuthUser(uid).catch(() => {});
      throw e;
    }
    await store.updateAuthUser(uid, { ban_duration: active ? 'none' : BAN_FOREVER });
    return res.status(200).json({ ok: true, driver });
  }

  async function updateDriver(body, res) {
    if (!UUID_RE.test(String(body.id || ''))) return fail(res, 400, 'bad_request');
    const d = await store.driverById(body.id);
    if (!d) return fail(res, 404, 'not_found');
    const fields = {};
    if (body.name !== undefined) { const n = cleanName(body.name); if (!n) return fail(res, 400, 'name_required'); fields.name = n; }
    if (body.phone !== undefined) {
      const phone = D.normalizePhone(body.phone);
      if (!phone) return fail(res, 400, 'bad_phone');
      if (phone !== d.phone) {
        const other = await store.driverByPhone(phone);
        if (other && other.id !== d.id) return fail(res, 409, 'phone_exists');
        const owner = await store.authUserByPhone(phone.slice(1));
        if (owner && owner !== d.user_id) return fail(res, 409, 'phone_exists');
        if (d.user_id) await store.updateAuthUser(d.user_id, { phone: phone.slice(1), phone_confirm: true });
        fields.phone = phone;
      }
    }
    const driver = Object.keys(fields).length ? await store.updateDriver(d.id, fields) : d;
    return res.status(200).json({ ok: true, driver });
  }

  // Désactiver : le compte est bloqué (plus de code, plus de connexion) et la base ne lui montre plus rien
  async function setActive(body, res) {
    if (!UUID_RE.test(String(body.id || ''))) return fail(res, 400, 'bad_request');
    const d = await store.driverById(body.id);
    if (!d) return fail(res, 404, 'not_found');
    const active = body.active === true;
    if (d.user_id) await store.updateAuthUser(d.user_id, { ban_duration: active ? 'none' : BAN_FOREVER });
    const driver = await store.updateDriver(d.id, { active });
    const openTrips = active ? 0 : await store.activeTripsOf(d.id);
    return res.status(200).json({ ok: true, driver, openTrips });
  }

  // Notification « nouvelle tournée » : un lien seulement. La tournée reste visible même si l'envoi échoue.
  async function notify(body, res, user) {
    if (!UUID_RE.test(String(body.trip_id || ''))) return fail(res, 400, 'bad_request');
    const trip = await store.getTrip(body.trip_id);
    if (!trip) return fail(res, 404, 'not_found');
    if (!trip.published_at || !trip.driver_id) return fail(res, 409, 'not_published');
    const d = await store.driverById(trip.driver_id);
    if (!d || !d.active) return fail(res, 409, 'driver_inactive');
    let status, detail = null;
    if (!sms.configured()) { status = 'not_configured'; detail = 'SMS provider not configured'; }
    else {
      try { detail = 'id ' + await sms.send(d.phone, D.notifyText(env.PUBLIC_URL || DRIVER_URL)); status = 'sent'; }
      catch (e) { status = 'failed'; detail = String(e && e.message || e).slice(0, 300); }
    }
    await store.addNotification({ trip_id: trip.id, driver_id: d.id, status, detail });
    // l'historique ne doit pas faire croire à un échec d'envoi (sinon l'équipe renverrait le SMS)
    try { await store.addEvent({ trip_id: trip.id, actor: user.id, actor_kind: 'staff', kind: 'notified', to_value: status, note: d.id }); }
    catch (e) { log('drivers notify historique', e && e.message); }
    return res.status(200).json({ ok: true, status });
  }
}

// ---------- SMS de connexion : crochet « Send SMS » de Supabase Auth ----------
// Signature « Standard Webhooks » : HMAC-SHA256 de « id.horodatage.corps », clé = secret « v1,whsec_… » décodé (base64)
function verifyStandardWebhook(raw, headers, secrets, nowSec = Math.floor(Date.now() / 1000)) {
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sig = headers['webhook-signature'];
  if (!id || !ts || !sig || !secrets) return false;
  if (!/^\d+$/.test(String(ts)) || Math.abs(nowSec - Number(ts)) > 300) return false;   // 5 minutes au plus
  const signed = Buffer.concat([Buffer.from(`${id}.${ts}.`), Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))]);
  const given = String(sig).split(' ').map(s => s.startsWith('v1,') ? s.slice(3) : '').filter(Boolean).map(s => Buffer.from(s));
  for (const secret of String(secrets).split('|')) {
    const b64 = secret.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
    if (!b64) continue;
    const expected = Buffer.from(crypto.createHmac('sha256', Buffer.from(b64, 'base64')).update(signed).digest('base64'));
    if (given.some(g => g.length === expected.length && crypto.timingSafeEqual(g, expected))) return true;
  }
  return false;
}

// Réponse d'erreur que Supabase Auth relaie telle quelle à l'écran de connexion (statut HTTP 200 obligatoire)
const hookError = (res, code, message) => res.status(200).json({ error: { http_code: code, message } });

function smsHookHandler({ env, store, sms, log = console.error, now = () => Date.now() }) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const raw = await readRaw(req);
    if (!env.SMS_HOOK_SECRET || !store || !verifyStandardWebhook(raw, req.headers || {}, env.SMS_HOOK_SECRET, Math.floor(now() / 1000))) {
      log('sms-hook refusé', JSON.stringify({ corps: raw.length, secret: String(env.SMS_HOOK_SECRET || '').length }));
      return res.status(401).json({ error: { http_code: 401, message: 'unauthorized' } });
    }
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return hookError(res, 400, 'bad_payload'); }
    const user = body && body.user, otp = body && body.sms && body.sms.otp;
    if (!user || !user.id || !otp) return hookError(res, 400, 'bad_payload');
    try {
      const d = await store.driverByUser(user.id);
      const phone = D.normalizePhone('+' + String(user.phone || '').replace(/^\+/, ''));
      if (!d || !phone || phone !== d.phone) return hookError(res, 403, 'driver_unknown');
      const banned = user.banned_until && Date.parse(user.banned_until) > now();
      if (!d.active || banned) return hookError(res, 403, 'driver_inactive');
      if (!sms.configured()) return hookError(res, 500, 'sms_not_configured');
      await sms.send(phone, D.otpText(otp));
      return res.status(200).json({});
    } catch (e) {
      log('sms-hook', e && e.message);
      return hookError(res, 500, 'sms_send_failed');
    }
  };
}

module.exports = { driversHandler, smsHookHandler, verifyStandardWebhook, DRIVER_URL };
