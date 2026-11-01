// Accès serveur à la base et au stockage du CRM (Supabase), avec la clé secrète.
// La clé secrète ne sert QU'ICI, côté serveur ; l'écran du CRM utilise la clé publique.
const SUPABASE_URL = 'https://fryxliuhaayyedmskohm.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_czw0QR_TnL5SY_Rjaq7lrw_q55YRGny';
const BUCKET = 'morning-pdf';

function createStore({ key, url = SUPABASE_URL, fetchImpl = fetch }) {
  const auth = { apikey: key };
  if (key.startsWith('eyJ')) auth.Authorization = 'Bearer ' + key; // ancienne clé « service_role »

  async function rest(method, path, body, extra) {
    const r = await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth, extra || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Base ${method} ${path.split('?')[0]} : ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  const inList = ids => '(' + ids.map(encodeURIComponent).join(',') + ')';
  async function inChunks(items, fn, size = 100) {
    for (let i = 0; i < items.length; i += size) await fn(items.slice(i, i + size));
  }
  const upsert = Object.freeze({ Prefer: 'resolution=merge-duplicates,return=minimal' });
  const minimal = Object.freeze({ Prefer: 'return=minimal' });

  return {
    listCustomers: () => rest('GET', 'customers?select=id,tax_id'),
    listLinked: () => rest('GET', 'morning_clients?select=morning_id,customer_id,synced_at'),
    upsertClients: rows => rest('POST', 'morning_clients?on_conflict=morning_id', rows, upsert),
    deleteClients: ids => inChunks(ids, part => rest('DELETE', 'morning_clients?morning_id=in.' + inList(part), undefined, minimal)),
    docsOfClient: mcid => rest('GET', 'morning_documents?select=morning_id,pdf_path&morning_client_id=eq.' + encodeURIComponent(mcid)),
    docsNotOfClients: mcids => rest('GET', 'morning_documents?select=morning_id,pdf_path' + (mcids.length ? '&morning_client_id=not.in.' + inList(mcids) : '')),
    upsertDocs: rows => inChunks(rows, part => rest('POST', 'morning_documents?on_conflict=morning_id', part, upsert), 200),
    deleteDocs: ids => inChunks(ids, part => rest('DELETE', 'morning_documents?morning_id=in.' + inList(part), undefined, minimal)),
    docsWithoutPdf: limit => rest('GET', `morning_documents?select=morning_id,customer_id&pdf_path=is.null&order=doc_date.desc&limit=${limit}`),
    setPdf: (id, path) => rest('PATCH', 'morning_documents?morning_id=eq.' + encodeURIComponent(id), { pdf_path: path }, minimal),
    setState: s => rest('PATCH', 'morning_sync?id=eq.1', s, minimal),
    getState: async () => ((await rest('GET', 'morning_sync?select=*&id=eq.1')) || [])[0] || null,
    clientSyncedSince: async (customerId, sinceIso) =>
      ((await rest('GET', `morning_clients?select=morning_id&customer_id=eq.${encodeURIComponent(customerId)}&synced_at=gte.${encodeURIComponent(sinceIso)}&limit=1`)) || []).length > 0,

    async uploadPdf(path, buf) {
      const r = await fetchImpl(`${url}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST', headers: Object.assign({ 'Content-Type': 'application/pdf', 'x-upsert': 'true' }, auth), body: buf
      });
      if (!r.ok) throw new Error('Stockage : envoi PDF ' + r.status + ' ' + (await r.text()).slice(0, 200));
    },
    removePdfs: paths => inChunks(paths, async part => {
      const r = await fetchImpl(`${url}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: JSON.stringify({ prefixes: part })
      });
      if (!r.ok) throw new Error('Stockage : suppression PDF ' + r.status);
    }),

    // Fait-il partie de l'équipe ? (les livreurs n'en font pas partie)
    isStaff: async uid => ((await rest('GET', 'app_staff?select=user_id&user_id=eq.' + encodeURIComponent(uid))) || []).length > 0,

    // Vérifie qu'un jeton de connexion du CRM est valide ; renvoie l'utilisateur ou null
    async userFromToken(accessToken) {
      const r = await fetchImpl(`${url}/auth/v1/user`, { headers: { apikey: PUBLISHABLE_KEY, Authorization: 'Bearer ' + accessToken } });
      if (!r.ok) return null;
      const u = await r.json().catch(() => null);
      return u && u.id ? u : null;
    }
  };
}

module.exports = { createStore };
