// Synchronisation Morning → CRM.
// Règle de sécurité : seuls les clients Morning dont le ח.פ existe dans une fiche du CRM sont copiés.
// Les documents d'un autre client ne sont jamais enregistrés, et les liens Morning ne sont jamais stockés.
const crypto = require('crypto');
const L = require('../../ledger.js');

// Vérifie la signature d'une alerte Morning : HMAC-SHA256 (hex) du corps brut, avec le secret du webhook
function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function clientRow(link, stamp) {
  const m = link.morning;
  return {
    morning_id: m.id,
    customer_id: link.customer_id,
    name: m.name || null,
    tax_id: m.taxId || null,
    active: m.active !== false,
    income_amount: m.incomeAmount == null ? null : m.incomeAmount,
    payment_amount: m.paymentAmount == null ? null : m.paymentAmount,
    balance_amount: m.balanceAmount == null ? null : m.balanceAmount,
    synced_at: stamp
  };
}

// morning : accès à l'API Morning (lecture seule) ; store : base + stockage du CRM
function createSync({ morning, store, now = () => new Date() }) {
  async function removeDocs(rows) {
    if (!rows.length) return;
    const paths = rows.map(r => r.pdf_path).filter(Boolean);
    if (paths.length) await store.removePdfs(paths);
    await store.deleteDocs(rows.map(r => r.morning_id));
  }

  // Recopie tous les documents d'une fiche Morning reliée, et efface ceux qui n'y sont plus
  async function syncClientDocs(link, stamp) {
    const docs = (await morning.listDocs(link.morning.id)).filter(d => L.SYNC_TYPES.includes(d.type));
    const rows = docs.map(d => Object.assign(L.docToRow(d, link.customer_id), { morning_client_id: link.morning.id, synced_at: stamp }));
    if (rows.length) await store.upsertDocs(rows);
    const keep = new Set(rows.map(r => r.morning_id));
    await removeDocs((await store.docsOfClient(link.morning.id)).filter(d => !keep.has(d.morning_id)));
    return rows.length;
  }

  // Copie dans le stockage privé les PDF originaux pas encore copiés (avec une limite par passage)
  async function copyPdfs(limit, deadline) {
    let copied = 0;
    for (const d of await store.docsWithoutPdf(limit)) {
      if (deadline && Date.now() > deadline) break;
      const pdf = await morning.fetchPdf(d.morning_id);
      if (!pdf) continue;
      const path = `${d.customer_id}/${d.morning_id}.pdf`;
      await store.uploadPdf(path, pdf);
      await store.setPdf(d.morning_id, path);
      copied++;
    }
    return copied;
  }

  // Synchro de tous les clients reliés, ou d'un seul client du CRM (customerId)
  async function syncAll({ customerId, maxPdf = 1000, deadline } = {}) {
    const stamp = now().toISOString();
    try {
      const [mclients, customers] = await Promise.all([morning.listClients(), store.listCustomers()]);
      let { links, conflicts } = L.matchClients(customers, mclients);
      if (customerId) links = links.filter(l => l.customer_id === customerId);

      // Fiches Morning qui ne sont plus reliées (client supprimé du CRM, ח.פ changé) → tout effacer
      const keepIds = links.map(l => l.morning.id);
      const linked = (await store.listLinked()).filter(c => !customerId || c.customer_id === customerId);
      const gone = linked.filter(c => !keepIds.includes(c.morning_id)).map(c => c.morning_id);
      if (customerId) for (const id of gone) await removeDocs(await store.docsOfClient(id));
      else await removeDocs(await store.docsNotOfClients(keepIds));
      if (gone.length) await store.deleteClients(gone);

      if (links.length) await store.upsertClients(links.map(l => clientRow(l, stamp)));
      let documents = 0;
      for (const l of links) documents += await syncClientDocs(l, stamp);
      const pdfs = await copyPdfs(maxPdf, deadline);

      if (!customerId) {
        await store.setState({
          last_run: stamp, last_ok: stamp, clients: links.length, documents,
          last_error: conflicts.length ? 'ח.פ כפול ב-CRM: ' + conflicts.join(', ') : null
        });
      }
      return { clients: links.length, documents, pdfs, conflicts };
    } catch (e) {
      try { await store.setState({ last_run: stamp, last_error: String((e && e.message) || e).slice(0, 500) }); } catch (_) { /* rien */ }
      throw e;
    }
  }

  // Alerte Morning « document créé » : met à jour le client concerné s'il est dans le CRM, sinon ignore
  async function onDocumentCreated(docId) {
    const doc = await morning.getDoc(docId);
    const mcid = doc && doc.client && doc.client.id;
    if (!mcid) return { stored: false, reason: 'document sans client' };
    const m = await morning.getClient(mcid);
    const { links } = L.matchClients(await store.listCustomers(), m ? [m] : []);
    if (!links.length) return { stored: false, reason: 'client absent du CRM' };
    const link = links[0];
    const stamp = now().toISOString();
    await store.upsertClients([clientRow(link, stamp)]);
    await syncClientDocs(link, stamp);
    await copyPdfs(20, Date.now() + 40000);
    return { stored: true, customer_id: link.customer_id };
  }

  return { syncAll, onDocumentCreated };
}

module.exports = { createSync, verifySignature };
