/* Calcul des comptes clients à partir des documents Morning.
   Utilisé à la fois par l'écran du CRM (window.Ledger) et par le serveur (require).
   Formule vérifiée le 30/10/2026 : identique au solde Morning pour les 47 fiches reliées. */
(function (root) {
  // 305 חשבונית מס, 320 חשבונית מס/קבלה, 330 זיכוי, 400 קבלה
  const SYNC_TYPES = [305, 320, 330, 400];
  const INVOICE_TYPES = [305, 320];
  const PAYMENT_TYPES = [400, 320];

  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const normTax = s => String(s == null ? '' : s).replace(/\D/g, '').replace(/^0+/, '');

  // Effet d'un document : ce qu'il ajoute à la facturation (inc) et aux paiements (pay)
  function effect(d) {
    const a = Number(d.amount) || 0;
    const inc = INVOICE_TYPES.includes(d.type) ? a : d.type === 330 ? -a : 0;
    const pay = PAYMENT_TYPES.includes(d.type) ? a : 0;
    return { inc, pay };
  }

  // Solde : due > 0 = le client doit de l'argent (= −balanceAmount de Morning)
  function balance(docs) {
    let invoiced = 0, paid = 0;
    for (const d of docs) { const e = effect(d); invoiced += e.inc; paid += e.pay; }
    return { invoiced: r2(invoiced), paid: r2(paid), due: r2(invoiced - paid) };
  }

  const isSettled = due => Math.abs(Number(due) || 0) < 1;

  function docStatus(d) {
    const isInvoice = INVOICE_TYPES.includes(d.type) || d.type === 300;
    // annulé : barré ; document d'annulation : grisé mais compté (il compense le document annulé)
    if (d.status === 4) return { label: isInvoice ? 'בוטלה' : 'בוטל', tone: 'muted', cancelled: true, muted: true };
    if (d.status === 3) return { label: 'מבטל', tone: 'muted', cancelled: false, muted: true };
    if (!isInvoice) return { label: '', tone: '', cancelled: false, muted: false };
    if (d.status === 1) return { label: 'סגורה', tone: 'success', cancelled: false, muted: false };
    if (d.status === 2) return { label: 'נסגרה ידנית', tone: 'success', cancelled: false, muted: false };
    const open = d.amount_opened == null ? Number(d.amount) : Number(d.amount_opened);
    if (open > 0.009 && open < Number(d.amount) - 0.009) return { label: 'שולמה חלקית', tone: 'warning', cancelled: false, muted: false };
    return { label: 'פתוחה', tone: 'danger', cancelled: false, muted: false };
  }

  // Compte (כרטסת) : ordre chronologique, avec débit / crédit / solde cumulé
  function ledger(docs) {
    const sorted = docs.slice().sort((a, b) =>
      String(a.doc_date || '').localeCompare(String(b.doc_date || '')) ||
      String(a.number || '').localeCompare(String(b.number || ''), undefined, { numeric: true }));
    let run = 0;
    return sorted.map(d => {
      const { inc, pay } = effect(d);
      run += inc - pay;
      return Object.assign({}, d, {
        debit: r2(Math.max(inc, 0) + Math.max(-pay, 0)),
        credit: r2(Math.max(-inc, 0) + Math.max(pay, 0)),
        running: r2(run)
      });
    });
  }

  // Factures pas encore payées (חשבונית מס ouvertes), les plus anciennes d'abord, avec le reste à payer selon Morning.
  // Un reste négatif (trop payé) ou de moins de 1 ₪ (arrondi) ne compte pas.
  function openInvoices(docs) {
    return docs
      .filter(d => d.type === 305 && d.status === 0)
      .map(d => {
        const remaining = r2(d.amount_opened == null ? d.amount : d.amount_opened);
        return Object.assign({}, d, { remaining, partial: remaining < r2(d.amount) - 0.009 });
      })
      .filter(d => d.remaining >= 1)
      .sort((a, b) => String(a.doc_date || '').localeCompare(String(b.doc_date || '')));
  }

  // Dette affichée dans le CRM = ce qui reste à payer sur les factures ouvertes.
  // (Le solde comptable de Morning garde aussi les factures fermées à la main : on ne l'affiche plus.)
  function openDebt(docs) {
    return r2(openInvoices(docs).reduce((s, d) => s + d.remaining, 0));
  }

  // Reçus encore ouverts dans Morning = paiements pas rattachés à une facture
  function unlinkedPayments(docs) {
    return docs
      .filter(d => d.type === 400 && d.status === 0)
      .slice()
      .sort((a, b) => String(a.doc_date || '').localeCompare(String(b.doc_date || '')));
  }

  // Relie chaque fiche Morning à la fiche CRM qui a le même ח.פ.
  // Un ח.פ présent dans plusieurs fiches CRM = conflit : rien n'est relié pour ce ח.פ.
  function matchClients(customers, morningClients) {
    const byTax = new Map();
    for (const c of customers) {
      const k = normTax(c.tax_id);
      if (!k) continue;
      byTax.set(k, byTax.has(k) ? null : c.id);
    }
    const links = [], conflicts = [];
    for (const m of morningClients) {
      const k = normTax(m.taxId);
      if (!k || !byTax.has(k)) continue;
      const cid = byTax.get(k);
      if (cid === null) { if (!conflicts.includes(k)) conflicts.push(k); continue; }
      links.push({ customer_id: cid, morning: m });
    }
    return { links, conflicts };
  }

  // Document Morning → ligne de la table morning_documents (sans aucun lien Morning)
  function docToRow(doc, customerId) {
    const amount = doc.amountLocal != null ? doc.amountLocal : doc.amount;
    const opened = doc.calculatedAmountOpenedLocal != null ? doc.calculatedAmountOpenedLocal : doc.amountOpened;
    return {
      morning_id: doc.id,
      customer_id: customerId,
      morning_client_id: doc.client && doc.client.id,
      type: doc.type,
      number: doc.number == null ? null : String(doc.number),
      status: doc.status,
      doc_date: doc.documentDate ? String(doc.documentDate).slice(0, 10) : null,
      amount: Number(amount) || 0,
      amount_opened: opened == null ? null : Number(opened),
      description: doc.description || null
    };
  }

  const api = { SYNC_TYPES, normTax, balance, isSettled, docStatus, ledger, openInvoices, openDebt, unlinkedPayments, matchClients, docToRow, r2 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ledger = api;
})(typeof self !== 'undefined' ? self : this);
