// Accès à l'API Morning — LECTURE SEULE (ce code n'appelle aucune fonction qui crée ou modifie quoi que ce soit).
// La clé Morning ne sort jamais du serveur.
const API = 'https://api.greeninvoice.co.il/api/v1';
const TOKEN_URL = 'https://api.morning.co/idp/v1/oauth/token';
const DOC_TYPES = [305, 320, 330, 400];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let cachedToken = null; // jeton valable 1 heure, gardé entre deux appels du même serveur

function createMorning({ clientId, clientSecret, fetchImpl = fetch }) {
  async function token() {
    if (cachedToken && cachedToken.clientId === clientId && cachedToken.expiresAt - 120 > Date.now() / 1000) return cachedToken.value;
    const r = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.accessToken) throw new Error(`Morning : jeton refusé (${r.status} ${j.error || ''})`);
    cachedToken = { value: j.accessToken, expiresAt: j.expiresAt, clientId };
    return cachedToken.value;
  }

  async function call(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetchImpl(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() },
        body: body ? JSON.stringify(body) : undefined
      });
      if (r.status === 401 && attempt === 0) { cachedToken = null; continue; }
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await sleep(1000 * 2 ** attempt); continue; }
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(`Morning ${method} ${path.split('/').slice(0, 2).join('/')} : ${r.status} ${(j && (j.errorMessage || j.message)) || ''}`);
      return j;
    }
  }

  async function paged(path, filters) {
    const items = [];
    for (let page = 1; ; page++) {
      const j = await call('POST', path, Object.assign({}, filters, { page, pageSize: 100 }));
      items.push(...((j && j.items) || []));
      if (page >= ((j && j.pages) || 1)) break;
    }
    return items;
  }

  return {
    listClients: () => paged('/clients/search', {}),
    getClient: id => call('GET', '/clients/' + encodeURIComponent(id)),
    // Sans fromDate, Morning ne renvoie que les documents récents : on demande tout l'historique
    listDocs: clientId => paged('/documents/search', { clientId, type: DOC_TYPES, fromDate: '2000-01-01', toDate: '2099-12-31' }),
    getDoc: id => call('GET', '/documents/' + encodeURIComponent(id)),
    // Télécharge le PDF original ; le lien Morning n'est utilisé qu'ici et n'est jamais enregistré
    async fetchPdf(docId) {
      const links = await call('GET', `/documents/${encodeURIComponent(docId)}/download/links`);
      const url = links && (links.origin || links.he);
      if (!url) return null;
      const r = await fetchImpl(url);
      if (!r.ok) throw new Error('Morning : PDF ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.subarray(0, 4).toString() !== '%PDF') throw new Error('Morning : le fichier reçu n\'est pas un PDF');
      return buf;
    }
  };
}

module.exports = { createMorning };
