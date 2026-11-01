// Accès serveur pour l'espace livreurs : table des livreurs, comptes de connexion (Supabase Auth),
// tournées et notifications. Clé secrète Supabase : côté serveur UNIQUEMENT.
const SUPABASE_URL = 'https://fryxliuhaayyedmskohm.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_czw0QR_TnL5SY_Rjaq7lrw_q55YRGny';

function createDriverStore({ key, url = SUPABASE_URL, fetchImpl = fetch }) {
  const auth = { apikey: key };
  if (key.startsWith('eyJ')) auth.Authorization = 'Bearer ' + key; // ancienne clé « service_role »
  async function call(method, path, body, extra) {
    const r = await fetchImpl(url + path, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, auth, extra || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* texte brut */ }
    if (!r.ok) { const e = new Error(`${method} ${path.split('?')[0]} : ${r.status} ${text.slice(0, 200)}`); e.status = r.status; e.body = json; throw e; }
    return json;
  }
  const rest = (m, p, b, x) => call(m, '/rest/v1/' + p, b, x);
  const one = rows => (rows && rows[0]) || null;
  const enc = encodeURIComponent;
  const ret = { Prefer: 'return=representation' };
  const COLS = 'id,name,phone,active,user_id,created_at,updated_at';

  return {
    async userFromToken(accessToken) {
      const r = await fetchImpl(url + '/auth/v1/user', { headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + accessToken } });
      if (!r.ok) return null;
      const u = await r.json().catch(() => null);
      return u && u.id ? u : null;
    },
    isStaff: async uid => !!one(await rest('GET', 'app_staff?select=user_id&user_id=eq.' + enc(uid))),

    driverById: async id => one(await rest('GET', `drivers?select=${COLS}&id=eq.${enc(id)}`)),
    driverByPhone: async phone => one(await rest('GET', `drivers?select=${COLS}&phone=eq.${enc(phone)}`)),
    driverByUser: async uid => one(await rest('GET', `drivers?select=${COLS}&user_id=eq.${enc(uid)}`)),
    insertDriver: async row => one(await rest('POST', 'drivers', row, ret)),
    updateDriver: async (id, fields) => one(await rest('PATCH', 'drivers?id=eq.' + enc(id), Object.assign({}, fields, { updated_at: new Date().toISOString() }), ret)),
    activeTripsOf: async driverId => (await rest('GET', `trips?select=id&driver_id=eq.${enc(driverId)}&published_at=not.is.null&date=gte.${new Date().toISOString().slice(0, 10)}`) || []).length,

    // Comptes de connexion par téléphone (Auth stocke le numéro sans « + »)
    authUserByPhone: async digits => (await rest('POST', 'rpc/admin_auth_user_by_phone', { p_phone: digits })) || null,
    async createAuthUser(digits) {
      const u = await call('POST', '/auth/v1/admin/users', { phone: digits, phone_confirm: true, app_metadata: { role: 'driver' } });
      return u && u.id;
    },
    updateAuthUser: (uid, fields) => call('PUT', '/auth/v1/admin/users/' + enc(uid), fields),
    deleteAuthUser: uid => call('DELETE', '/auth/v1/admin/users/' + enc(uid)),

    getTrip: async id => one(await rest('GET', `trips?select=id,date,name,driver_id,published_at&id=eq.${enc(id)}`)),

    // ---- accès par lien ----
    rpc: (name, args) => rest('POST', 'rpc/' + name, args),
    proofByPath: async p => one(await rest('GET', `delivery_proofs?select=id&storage_path=eq.${enc(p)}`)),
    // liens temporaires de lecture (fichiers déjà autorisés par la base)
    async signUrls(bucket, paths, expiresIn) {
      const r = await fetchImpl(`${url}/storage/v1/object/sign/${bucket}`, {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ expiresIn, paths })
      });
      if (!r.ok) throw new Error('Stockage : liens ' + r.status);
      const list = await r.json();
      return (list || []).filter(x => x && x.signedURL).map(x => ({ path: x.path, url: url + '/storage/v1' + x.signedURL }));
    },
    async removeFiles(bucket, paths) {
      if (!paths.length) return;
      await fetchImpl(`${url}/storage/v1/object/${bucket}`, { method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ prefixes: paths }) });
    },

    // ---- signatures (étape 2) ----
    // Arrêt d'une tournée PUBLIÉE attribuée à ce livreur, sinon null
    async stopForDriver(taskId, driverId) {
      const t = one(await rest('GET', `tasks?select=id,trip_id,customer_id&id=eq.${enc(taskId)}`));
      if (!t || !t.trip_id) return null;
      const r = one(await rest('GET', `trips?select=id&id=eq.${enc(t.trip_id)}&driver_id=eq.${enc(driverId)}&published_at=not.is.null`));
      return r ? t : null;
    },
    // Document Morning rattaché à cet arrêt par l'équipe, sinon null
    async linkedDoc(taskId, morningId) {
      const l = one(await rest('GET', `delivery_documents?select=morning_id&task_id=eq.${enc(taskId)}&morning_id=eq.${enc(morningId)}`));
      return l ? one(await rest('GET', `morning_documents?select=morning_id,type,number,pdf_path&morning_id=eq.${enc(morningId)}`)) : null;
    },
    signatureByRequest: async id => one(await rest('GET', `delivery_signatures?select=*&request_id=eq.${enc(id)}`)),
    signatureByDoc: async (taskId, morningId) => one(await rest('GET', `delivery_signatures?select=id&task_id=eq.${enc(taskId)}&morning_id=eq.${enc(morningId)}`)),
    async insertSignature(row) {
      try { return one(await rest('POST', 'delivery_signatures', row, ret)); }
      catch (e) { if (e.status === 409) return null; throw e; }   // déjà signé (deux envois en même temps)
    },
    async downloadPdf(path) {
      const r = await fetchImpl(`${url}/storage/v1/object/morning-pdf/${path.split('/').map(enc).join('/')}`, { headers: auth });
      if (!r.ok) throw new Error('Stockage : lecture PDF ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    },
    // Dépôt sans remplacement ; un fichier déjà présent (nouvel essai du même envoi) est accepté tel quel
    async uploadFile(path, buf, type) {
      const r = await fetchImpl(`${url}/storage/v1/object/delivery-proofs/${path}`, {
        method: 'POST', headers: Object.assign({ 'Content-Type': type, 'x-upsert': 'false', 'cache-control': 'max-age=0' }, auth), body: buf
      });
      if (r.ok) return;
      const t = await r.text();
      if (r.status === 409 || /duplicate|already exists/i.test(t)) return;
      throw new Error('Stockage : dépôt ' + r.status + ' ' + t.slice(0, 160));
    },
    addNotification: row => rest('POST', 'delivery_notifications', row, { Prefer: 'return=minimal' }),
    addEvent: row => rest('POST', 'delivery_events', row, { Prefer: 'return=minimal' })
  };
}

module.exports = { createDriverStore };
