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

test('factures ouvertes : seulement les חשבוניות מס non payées, les plus anciennes d\'abord, avec le reste à payer', () => {
  const docs = [
    { morning_id: '1', type: 305, status: 0, doc_date: '2026-09-08', amount: 100, amount_opened: 100 },
    { morning_id: '2', type: 305, status: 0, doc_date: '2026-08-01', amount: 500, amount_opened: 200 },
    { morning_id: '3', type: 305, status: 1, doc_date: '2026-07-01', amount: 80, amount_opened: 0 },
    { morning_id: '4', type: 305, status: 2, doc_date: '2026-07-02', amount: 90, amount_opened: 50 },
    { morning_id: '5', type: 305, status: 4, doc_date: '2026-07-03', amount: 70, amount_opened: 0 },
    { morning_id: '6', type: 400, status: 0, doc_date: '2026-07-04', amount: 60, amount_opened: 0 },
    { morning_id: '7', type: 320, status: 1, doc_date: '2026-07-05', amount: 40, amount_opened: 0 },
  ];
  const open = L.openInvoices(docs);
  assert.deepEqual(open.map(d => [d.morning_id, d.remaining, d.partial]), [['2', 200, true], ['1', 100, false]]);
});

test('dette = reste des factures ouvertes ; factures fermées à la main = plus de dette', () => {
  // cas réel : toutes les factures fermées à la main, Morning garde pourtant 13 204,63 ₪ dans son solde
  const docs = [
    { type: 305, status: 2, doc_date: '2023-05-01', amount: 1074.76, amount_opened: 1074.76 },
    { type: 305, status: 2, doc_date: '2026-01-21', amount: 10334.72, amount_opened: 10334.72 },
    { type: 400, status: 2, doc_date: '2026-02-12', amount: 9005.44, amount_opened: 0 },
  ];
  assert.equal(L.openDebt(docs), 0);
});

test('dette : somme des restes des factures ouvertes', () => {
  const docs = [
    { type: 305, status: 0, doc_date: '2024-04-30', amount: 1056, amount_opened: 517.5 },
    { type: 305, status: 0, doc_date: '2026-10-19', amount: 1699.44, amount_opened: 1699.44 },
    { type: 305, status: 1, doc_date: '2026-01-01', amount: 500, amount_opened: 0 },
  ];
  assert.equal(L.openDebt(docs), 2216.94);
});

test('factures ouvertes : reste négatif (trop payé) ou de moins de 1 ₪ (arrondi) = ignoré', () => {
  const docs = [
    { morning_id: 'a', type: 305, status: 0, doc_date: '2025-04-22', amount: 9080.1, amount_opened: 335.46 },
    { morning_id: 'b', type: 305, status: 0, doc_date: '2026-07-05', amount: 5561.51, amount_opened: -67.26 },
    { morning_id: 'c', type: 305, status: 0, doc_date: '2026-07-28', amount: 349.75, amount_opened: -3439.46 },
    { morning_id: 'd', type: 305, status: 0, doc_date: '2026-08-01', amount: 300, amount_opened: 0.26 },
  ];
  assert.deepEqual(L.openInvoices(docs).map(d => d.morning_id), ['a']);
  assert.equal(L.openDebt(docs), 335.46);
});

test('paiements non rattachés : les קבלות encore ouvertes, les plus anciennes d\'abord', () => {
  const docs = [
    { morning_id: 'r2', type: 400, status: 0, doc_date: '2025-07-01', amount: 4189 },
    { morning_id: 'r1', type: 400, status: 0, doc_date: '2025-03-25', amount: 5740.1 },
    { morning_id: 'r3', type: 400, status: 1, doc_date: '2025-01-01', amount: 100 },
    { morning_id: 'i1', type: 305, status: 0, doc_date: '2025-01-01', amount: 100, amount_opened: 100 },
  ];
  assert.deepEqual(L.unlinkedPayments(docs).map(d => d.morning_id), ['r1', 'r2']);
});

test('facture ouverte dont Morning ne donne pas le reste : tout le montant est dû', () => {
  const [d] = L.openInvoices([{ morning_id: 'x', type: 305, status: 0, doc_date: '2026-01-01', amount: 300, amount_opened: null }]);
  assert.equal(d.remaining, 300);
  assert.equal(d.partial, false);
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
    id: 'd1', type: 305, number: 1004, status: 0, documentDate: '2026-08-19', dueDate: '2026-09-18', amount: 2305, amountLocal: 2305,
    amountOpened: 2305, calculatedAmountOpenedLocal: 2305, description: 'טקסט', client: { id: 'm1' }, url: { origin: 'https://secret' }
  }, 'c1');
  assert.deepEqual(row, {
    morning_id: 'd1', customer_id: 'c1', morning_client_id: 'm1', type: 305, number: '1004', status: 0,
    doc_date: '2026-08-19', due_date: '2026-09-18', amount: 2305, amount_opened: 2305, description: 'טקסט'
  });
});

test('document Morning sans date d\'échéance : due_date vide', () => {
  const row = L.docToRow({ id: 'r1', type: 400, number: 7, status: 1, documentDate: '2026-08-19', amount: 50, client: { id: 'm1' } }, 'c1');
  assert.equal(row.due_date, null);
});

// Retards : on compte à partir de la date d'échéance Morning (sinon la date du document)
const OPEN = [
  { morning_id: 'a', type: 305, status: 0, doc_date: '2026-08-01', due_date: '2026-08-31', amount: 1000, amount_opened: 1000 },
  { morning_id: 'b', type: 305, status: 0, doc_date: '2026-09-20', due_date: '2026-10-20', amount: 500, amount_opened: 200 },
  { morning_id: 'c', type: 305, status: 0, doc_date: '2026-10-25', due_date: '2026-11-24', amount: 300, amount_opened: 300 },
  { morning_id: 'd', type: 305, status: 0, doc_date: '2026-07-01', due_date: null, amount: 80, amount_opened: 80 },
  { morning_id: 'e', type: 305, status: 1, doc_date: '2026-01-01', due_date: '2026-01-31', amount: 999, amount_opened: 0 },
];

test('jours de retard : depuis l\'échéance, 0 si elle n\'est pas passée', () => {
  assert.equal(L.daysLate(OPEN[0], '2026-11-01'), 62);
  assert.equal(L.daysLate(OPEN[1], '2026-11-01'), 12);
  assert.equal(L.daysLate(OPEN[2], '2026-11-01'), 0);
});

test('jours de retard : sans échéance Morning, échéance = fin du mois de la facture (שוטף, l\'usage le plus courant)', () => {
  // facture du 01/07 → échéance 31/07 → 93 jours de retard au 01/11
  assert.equal(L.daysLate(OPEN[3], '2026-11-01'), 93);
  // facture du 25/10 sans échéance : pas en retard avant le 01/11
  assert.equal(L.daysLate({ doc_date: '2026-10-25', due_date: null }, '2026-10-31'), 0);
  assert.equal(L.daysLate({ doc_date: '2026-10-25', due_date: null }, '2026-11-01'), 1);
  // décembre → 31/12 ; février → 28/02
  assert.equal(L.daysLate({ doc_date: '2026-12-10' }, '2027-01-01'), 1);
  assert.equal(L.daysLate({ doc_date: '2027-02-03' }, '2027-03-01'), 1);
});

test('jours de retard : le jour de l\'échéance n\'est pas encore un retard', () => {
  assert.equal(L.daysLate(OPEN[0], '2026-08-31'), 0);
  assert.equal(L.daysLate(OPEN[0], '2026-09-01'), 1);
});

test('montant en retard = reste des factures ouvertes dont l\'échéance est passée', () => {
  // a 1000 + b 200 + d 80 ; c pas encore échue ; e fermée
  assert.equal(L.overdueDebt(OPEN, '2026-11-01'), 1280);
  assert.equal(L.overdueDebt(OPEN, '2026-08-15'), 80);
});

test('plus long retard d\'un client (0 si rien en retard)', () => {
  assert.equal(L.maxDaysLate(OPEN, '2026-11-01'), 93);
  assert.equal(L.maxDaysLate([OPEN[2]], '2026-11-01'), 0);
  assert.equal(L.maxDaysLate([], '2026-11-01'), 0);
});

test('seuls les factures, avoirs et reçus sont synchronisés', () => {
  assert.deepEqual(L.SYNC_TYPES, [305, 320, 330, 400]);
});
