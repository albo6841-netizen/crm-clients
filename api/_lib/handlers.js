// Points d'entrée du serveur, séparés de Vercel pour pouvoir les tester.
const { verifySignature } = require('./sync.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUSTOMER_COOLDOWN_MS = 2 * 60 * 1000;   // une fiche : au plus une synchro toutes les 2 minutes
const FULL_COOLDOWN_MS = 5 * 60 * 1000;       // tous les clients (à la demande) : au plus toutes les 5 minutes

const configured = env => Boolean(env.MORNING_CLIENT_ID && env.MORNING_CLIENT_SECRET && env.SUPABASE_SECRET_KEY);
const bearerOf = req => {
  const h = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

// GET/POST /api/morning-sync
//   - tâche de nuit Vercel (Authorization: Bearer CRON_SECRET) → tous les clients
//   - utilisateur connecté au CRM (Authorization: Bearer <jeton>) → ?customer=<id> pour une fiche, sinon tous
function syncHandler({ env, store, sync, log = console.error }) {
  return async (req, res) => {
    if (!configured(env)) return res.status(503).json({ ok: false, error: 'not configured' });
    const bearer = bearerOf(req);
    const isCron = Boolean(env.CRON_SECRET) && bearer === env.CRON_SECRET;
    const customerId = (req.query && req.query.customer) || null;

    if (!isCron) {
      const user = bearer ? await store.userFromToken(bearer) : null;
      if (!user) return res.status(401).json({ ok: false });
      if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ ok: false });
      if (customerId) {
        if (await store.clientSyncedSince(customerId, new Date(Date.now() - CUSTOMER_COOLDOWN_MS).toISOString())) return res.status(200).json({ ok: true, skipped: true });
      } else {
        const st = await store.getState();
        if (st && st.last_run && Date.now() - Date.parse(st.last_run) < FULL_COOLDOWN_MS) return res.status(200).json({ ok: true, skipped: true });
      }
    }

    try {
      const one = !isCron && customerId;
      const r = await sync.syncAll({
        customerId: one ? customerId : undefined,
        maxPdf: one ? 100 : 400,
        deadline: Date.now() + (one ? 40000 : 240000)
      });
      return res.status(200).json({ ok: true, clients: r.clients, documents: r.documents, pdfs: r.pdfs });
    } catch (e) {
      log('morning-sync', e);
      return res.status(500).json({ ok: false, error: 'sync failed' });
    }
  };
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// POST /api/morning-webhook — alertes Morning signées (HMAC-SHA256 du corps brut)
function webhookHandler({ env, sync, log = console.error }) {
  return async (req, res) => {
    if (req.method !== 'POST') return res.status(405).end();
    const raw = await readRaw(req);
    if (!configured(env) || !verifySignature(raw, req.headers['x-webhook-signature'], env.MORNING_WEBHOOK_SECRET)) return res.status(401).end();
    const topic = req.headers['x-webhook-topic'];
    if (topic !== 'document/created') return res.status(200).json({ ok: true, ignored: true });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (_) { return res.status(400).end(); }
    const id = body && (body.id || (body.data && body.data.id));
    if (!id) return res.status(200).json({ ok: true, ignored: true });
    try {
      const r = await sync.onDocumentCreated(String(id));
      return res.status(200).json({ ok: true, stored: r.stored });
    } catch (e) {
      // On répond 200 : après 15 échecs Morning désactive l'alerte. La synchro de nuit rattrapera ce document.
      log('morning-webhook', e);
      return res.status(200).json({ ok: false });
    }
  };
}

module.exports = { syncHandler, webhookHandler };
