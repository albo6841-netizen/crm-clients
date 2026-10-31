/* Logique de la tournée (מסלולים) : ordre des arrêts, prochain arrêt, progression, heures prévues.
   Utilisée par l'écran du CRM (window.Tour) et par les tests (require). */
(function (root) {
  const ROAD = 1.3;      // la route est ~30 % plus longue que la ligne droite
  const SPEED = 50;      // km/h en moyenne en ville
  const VISIT = 15;      // minutes par visite

  const isHandled = s => !!(s.done || s.skipped);

  function haversine(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b[0] - a[0]), dLng = r(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const driveMin = (a, b) => haversine(a, b) * ROAD / SPEED * 60;
  const parseHM = s => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : 8 * 60; };
  const fmtHM = min => { min = Math.round(min); const h = Math.floor(min / 60) % 24, m = ((min % 60) + 60) % 60; return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };

  // Ordre de la journée : position choisie, puis les arrêts sans position dans l'ordre de création
  function orderStops(stops) {
    return stops.slice().sort((a, b) => {
      const pa = a.position == null ? Infinity : a.position, pb = b.position == null ? Infinity : b.position;
      if (pa !== pb) return pa - pb;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
  }

  const nextStop = ordered => ordered.find(s => !isHandled(s)) || null;

  function tripStatus(stops) {
    const total = stops.length, done = stops.filter(s => s.done).length;
    const skipped = stops.filter(s => !s.done && s.skipped).length, handled = done + skipped;
    const label = !total ? 'ריק' : handled === total ? 'הושלם' : handled ? 'בתהליך' : 'מתוכנן';
    return { total, done, skipped, handled, remaining: total - handled, label };
  }

  // ↑ : remonte un arrêt d'une place ; renvoie les nouvelles positions 1..n de toute la journée
  function moveUp(ordered, id) {
    const list = ordered.slice(), i = list.findIndex(s => s.id === id);
    if (i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    return list.map((s, k) => ({ id: s.id, position: k + 1 }));
  }

  // Heures prévues : départ → arrêts (dans l'ordre, sauf « pas visité » et sans GPS) → arrivée
  function planEtas({ startLL, startTime, stops, endLL }) {
    let t = parseHM(startTime), prev = startLL || null, first = true;
    const etas = {};
    for (const s of stops) {
      if (s.skipped || !s.ll) continue;
      if (prev) t += driveMin(prev, s.ll);   // sans adresse de départ : le 1er arrêt est à l'heure de départ
      etas[s.id] = fmtHM(t);
      t += VISIT;
      prev = s.ll; first = false;
    }
    if (endLL && prev) t += driveMin(prev, endLL);
    return { etas, finish: first && !endLL ? null : fmtHM(t) };
  }

  // Ordre le plus court (plus proche voisin + améliorations 2-opt), départ et arrivée fixes.
  // Les arrêts sans GPS restent à la fin, dans leur ordre actuel.
  function optimizeOrder(startLL, stops, endLL) {
    const located = stops.filter(s => s.ll), lost = stops.filter(s => !s.ll);
    if (!located.length) return stops.slice();
    const startPt = startLL || located[0].ll;
    const rem = located.slice(), order = [];
    let cur = startPt;
    while (rem.length) {
      let bi = 0, bd = Infinity;
      rem.forEach((s, i) => { const d = haversine(cur, s.ll); if (d < bd) { bd = d; bi = i; } });
      order.push(rem[bi]); cur = rem[bi].ll; rem.splice(bi, 1);
    }
    const len = path => {
      let d = 0, p = startPt;
      for (const s of path) { d += haversine(p, s.ll); p = s.ll; }
      if (endLL) d += haversine(p, endLL);
      return d;
    };
    let best = order, improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < best.length - 1; i++) for (let k = i + 1; k < best.length; k++) {
        const np = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        if (len(np) < len(best) - 1e-9) { best = np; improved = true; }
      }
    }
    return best.concat(lost);
  }

  const api = { orderStops, nextStop, tripStatus, moveUp, planEtas, optimizeOrder, haversine, isHandled, fmtHM, parseHM };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tour = api;
})(typeof self !== 'undefined' ? self : this);
