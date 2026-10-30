// Tests de la synchronisation Morning → CRM, avec un faux Morning et une fausse base en mémoire.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSync, verifySignature } = require('../api/_lib/sync.js');

function fakeWorld() {
  const morning = {
    clients: [
      { id: 'm-deal', name: 'לקוח א', taxId: '111111118', active: true, incomeAmount: 100, paymentAmount: 40, balanceAmount: -60 },
      { id: 'm-other', name: 'לקוח לא ב-CRM', taxId: '999999999', active: true, incomeAmount: 5, paymentAmount: 0, balanceAmount: -5 },
      { id: 'm-pinsker', name: 'לקוח ב', taxId: '222222226', active: true, incomeAmount: 10, paymentAmount: 10, balanceAmount: 0 },
    ],
    docs: {
      'm-deal': [
        { id: 'd1', type: 305, number: 1, status: 0, documentDate: '2026-08-19', amountLocal: 100, amountOpened: 60, client: { id: 'm-deal' } },
        { id: 'd2', type: 400, number: 2, status: 1, documentDate: '2026-08-20', amountLocal: 40, client: { id: 'm-deal' } },
      ],
      'm-other': [{ id: 'x1', type: 305, number: 9, status: 0, documentDate: '2026-08-01', amountLocal: 5, client: { id: 'm-other' } }],
      'm-pinsker': [{ id: 'p1', type: 320, number: 3, status: 1, documentDate: '2026-07-01', amountLocal: 10, client: { id: 'm-pinsker' } }],
    },
    calls: [],
    async listClients() { this.calls.push('listClients'); return this.clients; },
    async getClient(id) { this.calls.push('getClient:' + id); return this.clients.find(c => c.id === id); },
    async listDocs(clientId) { this.calls.push('listDocs:' + clientId); return this.docs[clientId] || []; },
    async getDoc(id) { this.calls.push('getDoc:' + id); return Object.values(this.docs).flat().find(d => d.id === id); },
    async fetchPdf(docId) { this.calls.push('pdf:' + docId); return Buffer.from('%PDF ' + docId); },
  };
  const store = {
    customers: [{ id: 'c-deal', tax_id: '111111118' }, { id: 'c-pinsker', tax_id: '222222226' }, { id: 'c-none', tax_id: null }],
    clients: new Map(), docs: new Map(), files: new Map(), state: {},
    async listCustomers() { return this.customers; },
    async listLinked() { return [...this.clients.values()]; },
    async upsertClients(rows) { for (const r of rows) this.clients.set(r.morning_id, { ...r }); },
    async deleteClients(ids) { for (const id of ids) this.clients.delete(id); },
    async docsOfClient(mcid) { return [...this.docs.values()].filter(d => d.morning_client_id === mcid); },
    async docsNotOfClients(mcids) { return [...this.docs.values()].filter(d => !mcids.includes(d.morning_client_id)); },
    async upsertDocs(rows) { for (const r of rows) this.docs.set(r.morning_id, { ...(this.docs.get(r.morning_id) || {}), ...r }); },
    async deleteDocs(ids) { for (const id of ids) this.docs.delete(id); },
    async docsWithoutPdf(limit) { return [...this.docs.values()].filter(d => !d.pdf_path).slice(0, limit); },
    async setPdf(id, path) { this.docs.get(id).pdf_path = path; },
    async uploadPdf(path, buf) { this.files.set(path, buf); },
    async removePdfs(paths) { for (const p of paths) this.files.delete(p); },
    async setState(s) { Object.assign(this.state, s); },
  };
  return { morning, store, sync: createSync({ morning, store, now: () => new Date('2026-10-30T10:00:00Z') }) };
}

test('synchro complète : seuls les clients du CRM sont copiés, avec leurs documents et PDF', async () => {
  const { morning, store, sync } = fakeWorld();
  await sync.syncAll();
  assert.deepEqual([...store.clients.keys()].sort(), ['m-deal', 'm-pinsker']);
  assert.deepEqual([...store.docs.keys()].sort(), ['d1', 'd2', 'p1']);
  assert.equal(store.docs.get('d1').customer_id, 'c-deal');
  assert.equal(store.docs.get('d1').pdf_path, 'c-deal/d1.pdf');
  assert.ok(store.files.has('c-deal/d1.pdf'));
  assert.ok(!morning.calls.includes('listDocs:m-other'), 'les documents d\'un client hors CRM ne sont jamais demandés');
  assert.ok(!morning.calls.includes('pdf:x1'));
  assert.equal(store.clients.get('m-deal').balance_amount, -60);
  assert.equal(store.state.clients, 2);
  assert.equal(store.state.documents, 3);
  assert.ok(store.state.last_ok);
});

test('synchro d\'un seul client : ne touche que lui', async () => {
  const { morning, store, sync } = fakeWorld();
  await sync.syncAll({ customerId: 'c-deal' });
  assert.deepEqual([...store.clients.keys()], ['m-deal']);
  assert.deepEqual([...store.docs.keys()].sort(), ['d1', 'd2']);
  assert.ok(!morning.calls.includes('listDocs:m-pinsker'));
});

test('client retiré du CRM (ou ח.פ changé) : sa fiche Morning, ses documents et ses PDF sont effacés', async () => {
  const { store, sync } = fakeWorld();
  await sync.syncAll();
  store.customers = store.customers.filter(c => c.id !== 'c-pinsker');
  await sync.syncAll();
  assert.ok(!store.clients.has('m-pinsker'));
  assert.ok(!store.docs.has('p1'));
  assert.ok(!store.files.has('c-pinsker/p1.pdf'));
});

test('document disparu de Morning pour un client relié : effacé du CRM', async () => {
  const { morning, store, sync } = fakeWorld();
  await sync.syncAll();
  morning.docs['m-deal'] = morning.docs['m-deal'].filter(d => d.id !== 'd2');
  await sync.syncAll();
  assert.ok(!store.docs.has('d2'));
  assert.ok(!store.files.has('c-deal/d2.pdf'));
});

test('statut mis à jour à la synchro suivante (facture payée)', async () => {
  const { morning, store, sync } = fakeWorld();
  await sync.syncAll();
  morning.docs['m-deal'][0] = { ...morning.docs['m-deal'][0], status: 1, amountOpened: 0 };
  await sync.syncAll();
  assert.equal(store.docs.get('d1').status, 1);
  assert.equal(store.docs.get('d1').pdf_path, 'c-deal/d1.pdf', 'le PDF déjà copié est gardé');
});

test('alerte Morning (webhook) pour un client hors CRM : rien n\'est enregistré', async () => {
  const { store, sync } = fakeWorld();
  const r = await sync.onDocumentCreated('x1');
  assert.equal(r.stored, false);
  assert.equal(store.docs.size, 0);
  assert.equal(store.files.size, 0);
});

test('alerte Morning pour un client du CRM : ses documents sont mis à jour avec le PDF', async () => {
  const { store, sync } = fakeWorld();
  const r = await sync.onDocumentCreated('d2');
  assert.equal(r.stored, true);
  assert.deepEqual([...store.docs.keys()].sort(), ['d1', 'd2']);
  assert.ok(store.files.has('c-deal/d2.pdf'));
  assert.equal(store.clients.get('m-deal').balance_amount, -60);
});

test('PDF : limite par passage, la suite au passage suivant', async () => {
  const { store, sync } = fakeWorld();
  await sync.syncAll({ maxPdf: 1 });
  assert.equal(store.files.size, 1);
  await sync.syncAll({ maxPdf: 5 });
  assert.equal(store.files.size, 3);
});

test('signature des alertes Morning (HMAC-SHA256 du corps brut)', () => {
  const body = Buffer.from('{"id":"d2"}');
  const good = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
  assert.equal(verifySignature(body, good, 's3cret'), true);
  assert.equal(verifySignature(body, good, 'autre'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
  assert.equal(verifySignature(body, 'abc', 's3cret'), false);
});
