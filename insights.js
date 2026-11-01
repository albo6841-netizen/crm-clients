/* Historique des visites d'un client et alertes de l'accueil (« כדאי לשים לב »).
   Utilisé par l'écran (window.Insights) et par les tests (require). */
(function (root) {
  const LATE_DAYS = 30;    // retard de paiement qui mérite une alerte
  const VISIT_DAYS = 21;   // temps sans visite qui mérite une alerte

  const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
  function daysBetween(from, to) {
    if (!from || !to) return null;
    return Math.round(dayNum(String(to)) - dayNum(String(from)));
  }

  // Jour (heure d'Israël) d'un horodatage ISO
  const IL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
  function localDay(iso) {
    const t = Date.parse(iso || '');
    return isNaN(t) ? '' : IL_DAY.format(new Date(t));
  }

  function hasGps(s) {
    const p = String((s && s.gps) || '').split(',').map(x => parseFloat(x.trim()));
    return p.length === 2 && !isNaN(p[0]) && !isNaN(p[1]);
  }

  // Une visite = un arrêt de tournée fait, ou une visite notée depuis la fiche (tâche 'visit' faite)
  const isVisit = t => t.done && !t.skipped && (t.type === 'visit' || !!t.tripId);

  function visitHistory(store, tasks) {
    const list = (tasks || [])
      .filter(t => t.customerId === store.id && isVisit(t))
      .map(t => ({ id: t.id, date: localDay(t.doneAt) || t.dueDate || '', note: t.visitNote || '', source: t.type === 'visit' ? 'manual' : 'tour', tripId: t.tripId || '' }))
      .filter(v => v.date);
    // date de dernière visite saisie à la main dans l'ancienne fiche
    if (store.lastVisit && !list.some(v => v.date === store.lastVisit))
      list.push({ id: 'legacy-' + store.id, date: store.lastVisit, note: '', source: 'legacy', tripId: '' });
    return list.sort((a, b) => b.date.localeCompare(a.date));
  }

  function lastVisit(store, tasks) {
    const h = visitHistory(store, tasks);
    return h.length ? h[0].date : '';
  }

  // Alertes : une par client, la plus importante (retard de paiement, puis visite, puis GPS)
  function suggestions({ stores, tasks, lateDays, today }) {
    const out = [];
    for (const s of stores || []) {
      const late = Number(lateDays ? lateDays(s.id) : 0) || 0;
      const lv = lastVisit(s, tasks);
      const since = lv ? daysBetween(lv, today) : null;
      if (late >= LATE_DAYS) out.push({ store: s, kind: 'late', days: late, text: 'יתרה בפיגור של ' + late + ' ימים' });
      else if (since != null && since >= VISIT_DAYS) out.push({ store: s, kind: 'visit', days: since, text: 'לא בוקר כבר ' + since + ' ימים' });
      else if (!hasGps(s)) out.push({ store: s, kind: 'gps', days: null, text: 'חסר מיקום למפה' });
    }
    const rank = { late: 0, visit: 1, gps: 2 };
    return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (b.days || 0) - (a.days || 0));
  }

  const api = { LATE_DAYS, VISIT_DAYS, daysBetween, localDay, hasGps, isVisit, visitHistory, lastVisit, suggestions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Insights = api;
})(typeof self !== 'undefined' ? self : this);
