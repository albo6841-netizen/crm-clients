// Ordre d'une tournée de livraison : places fixes (arrêts traités, cadenas), ordre manuel, proposition à vol d'oiseau,
// heures limites trouvées dans les notes. Fonctions pures, testées dans tests/route-plan.test.js.
(function (root) {
  'use strict';

  // Distance à vol d'oiseau en km entre deux points [lat, lng]
  function haversine(a, b) {
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Places fixes de la tournée. stops = [{ id, handled, locked }] dans l'ordre actuel.
  // Un arrêt traité garde sa place actuelle ; un arrêt verrouillé garde la place de son cadenas (1 = première).
  // Renvoie Map(index 0-based -> id). Deux cadenas sur la même place : le second prend la place libre la plus proche.
  // L'ordre de traitement des cadenas ne dépend PAS de l'ordre actuel (sinon deux cadenas en conflit
  // pourraient échanger leurs places à chaque rangement) : par place voulue, puis par identifiant.
  function fixedSlots(stops) {
    const n = stops.length, map = new Map();
    stops.forEach((s, i) => { if (s.handled) map.set(i, s.id); });
    const locks = stops.filter(s => !s.handled && s.locked > 0)
      .sort((a, b) => (a.locked - b.locked) || String(a.id).localeCompare(String(b.id)));
    for (const s of locks) {
      let want = Math.min(s.locked, n) - 1;
      if (map.has(want)) {
        let best = -1;
        for (let d = 1; d < n && best < 0; d++) {
          if (want + d < n && !map.has(want + d)) best = want + d;
          else if (want - d >= 0 && !map.has(want - d)) best = want - d;
        }
        want = best;
      }
      if (want >= 0) map.set(want, s.id);
    }
    return map;
  }

  // Range les arrêts : places fixes respectées, les autres remplissent les places libres dans l'ordre « wanted ».
  // wanted = ids dans l'ordre souhaité (les ids fixes y sont ignorés ; les ids libres absents vont à la fin).
  function arrange(stops, wanted) {
    const n = stops.length, fixed = fixedSlots(stops), fixedIds = new Set(fixed.values());
    const all = stops.map(s => s.id);
    const free = (wanted || all).filter(id => all.includes(id) && !fixedIds.has(id));
    for (const id of all) if (!fixedIds.has(id) && !free.includes(id)) free.push(id);
    const out = [];
    for (let i = 0; i < n; i++) out.push(fixed.has(i) ? fixed.get(i) : free.shift());
    return out;
  }

  const isFixedAt = (stops, i) => fixedSlots(stops).has(i);

  // Pourquoi un arrêt ne peut pas monter (dir = -1) ou descendre (+1) : null s'il le peut.
  // Il passe par-dessus les places fixes (arrêts traités, cadenas) jusqu'à la place libre suivante.
  // Codes : 'missing', 'self-handled', 'self-locked' (slot), 'edge' (plus de place du tout), 'fixed-beyond' (seulement des places fixes).
  function moveBlock(stops, id, dir) {
    const s = stops.find(x => x.id === id);
    if (!s) return { code: 'missing' };
    if (s.handled) return { code: 'self-handled' };
    const order = arrange(stops), fixed = fixedSlots(stops), i = order.indexOf(id);
    if (fixed.has(i)) return { code: 'self-locked', slot: i + 1 };
    for (let k = i + dir; k >= 0 && k < order.length; k += dir) if (!fixed.has(k)) return null;
    const next = i + dir;
    return next < 0 || next >= order.length ? { code: 'edge' } : { code: 'fixed-beyond' };
  }

  // Monter / descendre d'une place libre (les places fixes restent où elles sont). null si impossible (voir moveBlock).
  function move(stops, id, dir) {
    if (moveBlock(stops, id, dir)) return null;
    const order = arrange(stops), fixedIds = new Set(fixedSlots(stops).values());
    const free = order.filter(x => !fixedIds.has(x)), p = free.indexOf(id);
    [free[p], free[p + dir]] = [free[p + dir], free[p]];
    return arrange(stops, free);
  }

  // Pourquoi un arrêt ne peut pas passer en premier : null s'il le peut.
  // Codes : 'missing', 'self-handled', 'self-locked' (slot), 'already-first'.
  function firstBlock(stops, id) {
    const s = stops.find(x => x.id === id);
    if (!s) return { code: 'missing' };
    if (s.handled) return { code: 'self-handled' };
    const order = arrange(stops), fixed = fixedSlots(stops), i = order.indexOf(id);
    if (fixed.has(i)) return { code: 'self-locked', slot: i + 1 };
    const firstFree = order.findIndex((x, k) => !fixed.has(k));
    return i === firstFree ? { code: 'already-first' } : null;
  }

  // Mettre un arrêt en premier : il prend la première place libre (les places fixes ne bougent pas).
  function makeFirst(stops, id) {
    if (firstBlock(stops, id)) return null;
    const order = arrange(stops);
    return arrange(stops, [id].concat(order.filter(x => x !== id)));
  }

  // Proposition d'ordre à vol d'oiseau (plus proche voisin puis inversions 2-opt), places fixes respectées.
  // stops = [{ id, handled, locked, ll:[lat,lng]|null }] dans l'ordre actuel ; start/end = [lat,lng] ou null.
  // Renvoie { order, missing:[ids sans position] } ; s'il en manque, order = null.
  function suggest(stops, start, end) {
    const fixed = fixedSlots(stops), fixedIds = new Set(fixed.values());
    const missing = stops.filter(s => !s.handled && !s.ll).map(s => s.id);
    if (missing.length) return { order: null, missing };
    const byId = new Map(stops.map(s => [s.id, s]));
    const free = stops.filter(s => !fixedIds.has(s.id)).map(s => s.id);
    let anchor = start || null, order = [];
    for (let i = 0; i < stops.length; i++) {
      let id;
      if (fixed.has(i)) id = fixed.get(i);
      else {
        let bi = 0, bd = Infinity;
        free.forEach((f, k) => { const d = anchor ? haversine(anchor, byId.get(f).ll) : k; if (d < bd) { bd = d; bi = k; } });
        id = free.splice(bi, 1)[0];
      }
      order.push(id);
      const ll = byId.get(id).ll; if (ll) anchor = ll;
    }
    const score = o => {
      const pts = [start].concat(o.map(id => byId.get(id).ll), [end]).filter(Boolean);
      let d = 0; for (let k = 1; k < pts.length; k++) d += haversine(pts[k - 1], pts[k]); return d;
    };
    const fixedIdx = [...fixed.keys()];
    let improved = true, guard = 0;
    while (improved && guard++ < 60) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
        if (fixedIdx.some(k => k >= i && k <= j)) continue;
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (score(cand) < score(order) - 1e-9) { order = cand; improved = true; }
      }
    }
    return { order, missing: [] };
  }

  // Heure limite trouvée dans un texte libre (« עד 12:00 », « לפני 10:30 », « עד השעה 9:00 »).
  // Simple suggestion : renvoie { time:'HH:MM', excerpt } ou null. Il faut une heure avec minutes.
  function detectTime(text) {
    const t = String(text || '');
    const m = /(עד|לפני|לא אחרי)\s*(?:השעה\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)/.exec(t);
    if (!m) return null;
    const time = m[2].padStart(2, '0') + ':' + m[3];
    const a = Math.max(0, m.index - 20), b = Math.min(t.length, m.index + m[0].length + 25);
    return { time, excerpt: (a > 0 ? '…' : '') + t.slice(a, b).trim() + (b < t.length ? '…' : '') };
  }

  // ---- publication (étape 2) : même règle que le serveur (staff_publish_trip) ----
  // Un arrêt traité garde sa place PAR RAPPORT aux arrêts présents dans la version publiée ET dans le brouillon
  // (les ajouts et les retraits ne comptent pas). Renvoie les ids traités qui ont bougé.
  function handledMoved(publishedIds, draftIds, handled) {
    const inDraft = new Set(draftIds), inPub = new Set(publishedIds);
    const pubCommon = publishedIds.filter(id => inDraft.has(id)), draftCommon = draftIds.filter(id => inPub.has(id));
    return pubCommon.filter((id, k) => handled.has(id) && draftCommon.indexOf(id) !== k);
  }
  // Remet les arrêts traités à leur rang publié ; les autres arrêts communs gardent leur ordre du brouillon,
  // les arrêts ajoutés restent à leur place dans le brouillon.
  function repairHandled(publishedIds, draftIds, handled) {
    const inDraft = new Set(draftIds), inPub = new Set(publishedIds);
    const pubCommon = publishedIds.filter(id => inDraft.has(id));
    const fixed = new Map(); pubCommon.forEach((id, k) => { if (handled.has(id)) fixed.set(k, id); });
    const free = draftIds.filter(id => inPub.has(id) && !handled.has(id));
    const common = pubCommon.map((_, k) => fixed.has(k) ? fixed.get(k) : free.shift());
    return draftIds.map(id => inPub.has(id) ? common.shift() : id);
  }

  const api = { haversine, fixedSlots, arrange, isFixedAt, moveBlock, move, firstBlock, makeFirst, suggest, detectTime, handledMoved, repairHandled };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoutePlan = api;
})(typeof window !== 'undefined' ? window : this);
