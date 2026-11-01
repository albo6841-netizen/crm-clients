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
  function fixedSlots(stops) {
    const n = stops.length, map = new Map();
    stops.forEach((s, i) => { if (s.handled) map.set(i, s.id); });
    const locks = stops.filter(s => !s.handled && s.locked > 0).sort((a, b) => a.locked - b.locked);
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

  // Déplacer d'une place (dir = -1 vers le haut, +1 vers le bas). null si impossible (bord, arrêt fixe).
  function move(stops, id, dir) {
    const order = arrange(stops), i = order.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return null;
    const fixed = fixedSlots(stops);
    if (fixed.has(i) || fixed.has(j)) return null;
    const out = order.slice(); [out[i], out[j]] = [out[j], out[i]];
    return out;
  }

  // Mettre un arrêt en premier : il prend la première place libre (les places fixes ne bougent pas).
  function makeFirst(stops, id) {
    const s = stops.find(x => x.id === id);
    if (!s || s.handled || s.locked > 0) return null;   // arrêt verrouillé : on enlève d'abord le cadenas
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

  const api = { haversine, fixedSlots, arrange, isFixedAt, move, makeFirst, suggest, detectTime };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoutePlan = api;
})(typeof window !== 'undefined' ? window : this);
