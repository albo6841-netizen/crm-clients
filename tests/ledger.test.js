// Tests du calcul des comptes Morning (solde, statut des factures, liaison par ח.פ).
// Lancer : node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../ledger.js');

// Montants d'un vrai client relevés dans Morning (anonymisés), solde Morning : −2305.74
const DEAL = [
  { morning_id: 'a', type: 305, number: '1', status: 1, doc_date: '2026-05-25', amount: 3119.26, amount_opened: 0 },
  { morning_id: 'b', type: 400, number: '2', status: 1, doc_date: '2026-06-03', amount: 3119, amount_opened: 0 },
  { morning_id: 'c', type: 305, number: '3', status: 1, doc_date: '2026-07-29', amount: 2066.48, amount_opened: 0 },
  { morning_id: 'd', type: 305, number: '4', status: 0, doc_date: '2026-08-19', amount: 2305, amount_opened: 2305 },
  { morning_id: 'e', type: 330, number: '5', status: 3, doc_date: '2026-08-25', amount: 62, amount_opened: 0 },
  { morning_id: 'f', type: 400, number: '6', status: 1, doc_date: '2026-08-31', amount: 2004, amount_opened: 0 },
];

test('solde d\'un vrai client (anonymisé) identique à Morning', () => {
  const b = L.balance(DEAL);
  assert.equal(b.due, 2305.74);
  assert.equal(b.invoiced, 7428.74);
  assert.equal(b.paid, 5123);
});

test('facture annulée + avoir qui l\'annule = aucun effet sur le solde', () => {
  const b = L.balance([
    { type: 305, status: 4, amount: 7076.65 },
    { type: 330, status: 3, amount: 7076.65 },
  ]);
  assert.equal(b.due, 0);
});

test('reçu annulé + reçu d\'annulation (montant négatif) = aucun effet', () => {
  const b = L.balance([
    { type: 305, status: 0, amount: 9179 },
    { type: 400, status: 4, amount: 9179 },
    { type: 400, status: 3, amount: -9179 },
  ]);
  assert.equal(b.due, 9179);
});

test('חשבונית מס/קבלה (320) : facturée et payée d\'un coup', () => {
  assert.equal(L.balance([{ type: 320, status: 1, amount: 500 }]).due, 0);
});

test('bons de livraison et חשבון עסקה ne comptent pas', () => {
  assert.equal(L.balance([{ type: 200, status: 1, amount: 100 }, { type: 300, status: 2, amount: 50 }]).due, 0);
});

test('statut : facture ouverte entièrement', () => {
  assert.equal(L.docStatus({ type: 305, status: 0, amount: 2305, amount_opened: 2305 }).label, 'פתוחה');
});

test('statut : facture payée en partie', () => {
  assert.equal(L.docStatus({ type: 305, status: 0, amount: 3510, amount_opened: 2010 }).label, 'שולמה חלקית');
});

test('statut : facture fermée, fermée à la main, annulée', () => {
  assert.equal(L.docStatus({ type: 305, status: 1, amount: 10 }).label, 'סגורה');
  assert.equal(L.docStatus({ type: 305, status: 2, amount: 10 }).label, 'נסגרה ידנית');
  const c = L.docStatus({ type: 305, status: 4, amount: 10 });
  assert.equal(c.label, 'בוטלה');
  assert.equal(c.cancelled, true);
});

test('statut : document qui annule un autre = grisé mais PAS barré (il compte dans le solde)', () => {
  const s = L.docStatus({ type: 330, status: 3, amount: 62 });
  assert.equal(s.label, 'מבטל');
  assert.equal(s.cancelled, false);
  assert.equal(s.muted, true);
});

test('statut : document annulé = barré et grisé', () => {
  const s = L.docStatus({ type: 400, status: 4, amount: 10 });
  assert.equal(s.cancelled, true);
  assert.equal(s.muted, true);
});

test('statut : reçu normal sans étiquette', () => {
  assert.equal(L.docStatus({ type: 400, status: 1, amount: 10 }).label, '');
});

test('compte (כרטסת) : solde cumulé dans l\'ordre des dates, le dernier = solde total', () => {
  const rows = L.ledger(DEAL);
  assert.deepEqual(rows.map(r => r.running), [3119.26, 0.26, 2066.74, 4371.74, 4309.74, 2305.74]);
  const credit = rows.find(r => r.morning_id === 'e');
  assert.equal(credit.debit, 0);
  assert.equal(credit.credit, 62);
  const inv = rows.find(r => r.morning_id === 'a');
  assert.equal(inv.debit, 3119.26);
  assert.equal(inv.credit, 0);
});

test('compte : reçu d\'annulation négatif apparaît au débit', () => {
  const [r] = L.ledger([{ type: 400, status: 3, doc_date: '2026-06-14', amount: -9179 }]);
  assert.equal(r.debit, 9179);
  assert.equal(r.credit, 0);
});

test('compte : 320 apparaît au débit et au crédit', () => {
  const [r] = L.ledger([{ type: 320, status: 1, doc_date: '2026-01-01', amount: 500 }]);
  assert.equal(r.debit, 500);
  assert.equal(r.credit, 500);
  assert.equal(r.running, 0);
});

test('solde de moins de 1 ₪ = considéré comme payé', () => {
  assert.equal(L.isSettled(0.74), true);
  assert.equal(L.isSettled(-0.49), true);
  assert.equal(L.isSettled(1), false);
});

test('ח.פ normalisé : chiffres seulement, sans zéros devant', () => {
  assert.equal(L.normTax(' 033-333-334 '), '33333334');
  assert.equal(L.normTax(null), '');
});

test('liaison : chaque fiche Morning va à la fiche CRM qui a le même ח.פ', () => {
  const crm = [{ id: 'c1', tax_id: '111111118' }, { id: 'c2', tax_id: '033333334' }, { id: 'c3', tax_id: null }];
  const morning = [
    { id: 'm1', taxId: '111111118' },
    { id: 'm2', taxId: '33333334' },
    { id: 'm3', taxId: '111111118' },   // doublon Morning → même fiche CRM
    { id: 'm4', taxId: '999999999' },   // absent du CRM → jamais relié
    { id: 'm5', taxId: '' },
  ];
  const { links, conflicts } = L.matchClients(crm, morning);
  assert.deepEqual(links.map(l => [l.customer_id, l.morning.id]), [['c1', 'm1'], ['c2', 'm2'], ['c1', 'm3']]);
  assert.deepEqual(conflicts, []);
});

test('liaison : deux fiches CRM avec le même ח.פ → aucune liaison, signalé en conflit', () => {
  const crm = [{ id: 'c1', tax_id: '111111118' }, { id: 'c2', tax_id: '111111118' }];
  const { links, conflicts } = L.matchClients(crm, [{ id: 'm1', taxId: '111111118' }]);
  assert.deepEqual(links, []);
  assert.deepEqual(conflicts, ['111111118']);
});

test('conversion d\'un document Morning en ligne de la base', () => {
  const row = L.docToRow({
    id: 'd1', type: 305, number: 1004, status: 0, documentDate: '2026-08-19', amount: 2305, amountLocal: 2305,
    amountOpened: 2305, calculatedAmountOpenedLocal: 2305, description: 'טקסט', client: { id: 'm1' }, url: { origin: 'https://secret' }
  }, 'c1');
  assert.deepEqual(row, {
    morning_id: 'd1', customer_id: 'c1', morning_client_id: 'm1', type: 305, number: '1004', status: 0,
    doc_date: '2026-08-19', amount: 2305, amount_opened: 2305, description: 'טקסט'
  });
});

test('seuls les factures, avoirs et reçus sont synchronisés', () => {
  assert.deepEqual(L.SYNC_TYPES, [305, 320, 330, 400]);
});
