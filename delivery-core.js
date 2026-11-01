/* Logique des livraisons (espace livreur + suivi administrateur), sans accès au réseau.
   Utilisée par driver.html, index.html (window.Delivery), le serveur et les tests (require). */
(function (root) {
  // ---------- téléphone ----------
  // Accepte « 050-123-4567 », « +972 50 123 4567 », « 00972501234567 »… → format international « +972501234567 ».
  // Renvoie null si le numéro n'est pas exploitable.
  function normalizePhone(input) {
    let s = String(input == null ? '' : input).trim().replace(/[\s\-().‎‏]/g, '');
    if (!s) return null;
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (s.startsWith('+')) {
      let d = s.slice(1);
      if (!/^\d+$/.test(d)) return null;
      if (d.startsWith('9720')) d = '972' + d.slice(4);          // « +972 050… » : le 0 en trop
      if (d.startsWith('972') && !/^972\d{8,9}$/.test(d)) return null;
      return /^[1-9]\d{7,14}$/.test(d) ? '+' + d : null;
    }
    if (!/^\d+$/.test(s)) return null;
    if (s.startsWith('972')) return /^972\d{8,9}$/.test(s) ? '+' + s : null;
    if (s.startsWith('0') && /^0\d{8,9}$/.test(s)) return '+972' + s.slice(1);   // numéro israélien local
    return null;
  }
  // Affichage : numéros israéliens au format local (050-123-4567), les autres tels quels
  function displayPhone(e164) {
    const s = String(e164 || '');
    const m = /^\+972(\d{8,9})$/.exec(s);
    if (!m) return s;
    const local = '0' + m[1];
    return local.length === 10 ? local.slice(0, 3) + '-' + local.slice(3, 6) + '-' + local.slice(6) : local.slice(0, 2) + '-' + local.slice(2, 5) + '-' + local.slice(5);
  }

  // ---------- statuts d'une livraison ----------
  // null = encore à livrer. Les trois derniers sont des problèmes : une explication est obligatoire.
  const STATUSES = {
    pending:    { label: 'ממתין למסירה',   short: 'ממתין',       icon: 'clock',  tone: 'muted' },
    delivered:  { label: 'נמסר',           short: 'נמסר',        icon: 'check',  tone: 'ok' },
    partial:    { label: 'מסירה חלקית',    short: 'חלקית',       icon: 'half',   tone: 'problem' },
    absent:     { label: 'הלקוח לא נמצא',  short: 'לא נמצא',     icon: 'away',   tone: 'problem' },
    impossible: { label: 'לא ניתן למסור',  short: 'לא נמסר',     icon: 'block',  tone: 'problem' }
  };
  const FINAL = ['delivered', 'partial', 'absent', 'impossible'];
  const PROBLEMS = ['partial', 'absent', 'impossible'];
  const statusOf = s => (s && s.delivery_status) || 'pending';
  const statusInfo = st => STATUSES[st] || STATUSES.pending;
  const isDone = s => FINAL.includes(statusOf(s));
  const isProblem = s => PROBLEMS.includes(statusOf(s));
  const openProblem = s => isProblem(s) && !s.problem_resolved_at;
  const NOTE_MIN = 3;

  // Vérifie ce que le livreur envoie ; renvoie un message d'erreur (hébreu) ou null
  function checkStatusInput(status, note) {
    if (!FINAL.includes(status)) return 'יש לבחור סטטוס';
    if (PROBLEMS.includes(status) && String(note || '').trim().length < NOTE_MIN) return 'נא לכתוב הסבר קצר (מה קרה?)';
    return null;
  }

  // Ordre de la tournée : position choisie, puis ordre de création
  function orderStops(stops) {
    return (stops || []).slice().sort((a, b) => {
      const pa = a.position == null ? Infinity : a.position, pb = b.position == null ? Infinity : b.position;
      if (pa !== pb) return pa - pb;
      return String(a.created_at || a.createdAt || '').localeCompare(String(b.created_at || b.createdAt || ''));
    });
  }
  const nextStop = ordered => (ordered || []).find(s => !isDone(s)) || null;

  function progress(stops) {
    const list = stops || [];
    const total = list.length;
    const done = list.filter(isDone).length;
    const delivered = list.filter(s => statusOf(s) === 'delivered').length;
    const problems = list.filter(isProblem).length;
    const open = list.filter(openProblem).length;
    return { total, done, delivered, problems, openProblems: open, remaining: total - done, pct: total ? Math.round(done / total * 100) : 0 };
  }

  // Tournées du livreur : celle(s) du jour, les prochaines, les précédentes (dates « AAAA-MM-JJ »)
  function splitTrips(trips, today) {
    const t = (trips || []).slice();
    const byDate = (a, b) => String(a.date || '').localeCompare(String(b.date || ''));
    return {
      today: t.filter(x => x.date === today).sort(byDate),
      upcoming: t.filter(x => x.date && x.date > today).sort(byDate),
      past: t.filter(x => !x.date || x.date < today).sort(byDate).reverse()
    };
  }
  // Secteur d'une tournée : les villes de ses arrêts, sans doublon, dans l'ordre
  function areaOf(cities) {
    const seen = [];
    for (const c of cities || []) { const v = String(c || '').trim(); if (v && !seen.includes(v)) seen.push(v); }
    return seen.length > 3 ? seen.slice(0, 3).join(' · ') + ' +' + (seen.length - 3) : seen.join(' · ');
  }

  // ---------- connexion par SMS : messages compréhensibles ----------
  const SEC_RE = /after (\d+) seconds?/i;
  function authError(err) {
    const msg = String((err && (err.message || err.msg || err.error_description)) || err || '');
    const code = String((err && (err.code || err.error_code)) || '');
    const status = err && (err.status || err.statusCode);
    const sec = SEC_RE.exec(msg);
    if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg) || code === 'network')
      return { kind: 'network', text: 'אין חיבור לאינטרנט. בודקים את החיבור ומנסים שוב.' };
    if (sec || code === 'over_sms_send_rate_limit')
      return { kind: 'wait', seconds: sec ? +sec[1] : 60, text: 'אפשר לבקש קוד חדש בעוד ' + (sec ? sec[1] : 60) + ' שניות.' };
    if (/driver_inactive|banned/i.test(msg) || code === 'user_banned')
      return { kind: 'inactive', text: 'הגישה שלך הושבתה. לפרטים פונים למשרד.' };
    if (/signups? not allowed|otp_disabled|user not found|driver_unknown/i.test(msg) || code === 'otp_disabled' || code === 'signup_disabled')
      return { kind: 'unknown', text: 'המספר הזה לא רשום כנהג. בודקים את המספר, או פונים למשרד.' };
    if (/expired|invalid.*(token|otp)|token.*invalid/i.test(msg) || code === 'otp_expired')
      return { kind: 'code', text: 'הקוד שגוי או שפג תוקפו. מקלידים שוב, או מבקשים קוד חדש.' };
    if (/phone.*(format|invalid)|invalid phone/i.test(msg) || code === 'validation_failed')
      return { kind: 'phone', text: 'מספר הטלפון לא תקין.' };
    if (/rate limit|too many/i.test(msg) || status === 429 || /over_.*rate_limit/.test(code))
      return { kind: 'limit', text: 'יותר מדי ניסיונות. מנסים שוב בעוד כמה דקות.' };
    if (/sms|provider|hook|sending|twilio|not configured|unsupported phone/i.test(msg) || /sms_send_failed|hook/.test(code))
      return { kind: 'sms', text: 'לא הצלחנו לשלוח SMS כרגע. שירות ההודעות עדיין לא הוגדר או לא זמין. פונים למשרד.' };
    return { kind: 'other', text: 'משהו השתבש. מנסים שוב.' };
  }

  // ---------- envoi des photos : états affichés ----------
  // Une pièce n'est « התקבל » qu'après la réponse du serveur (stockage + enregistrement).
  const PROOF_STATES = {
    waiting: { label: 'ממתין לשליחה', icon: 'clock', tone: 'muted' },
    sending: { label: 'שולח…',        icon: 'upload', tone: 'muted' },
    received:{ label: 'התקבל',         icon: 'check', tone: 'ok' },
    failed:  { label: 'השליחה נכשלה',  icon: 'alert', tone: 'problem' }
  };
  // Chemin d'une pièce dans le stockage privé : <tournée>/<arrêt>/<identifiant>.jpg
  const proofPath = (tripId, taskId, id, ext) => tripId + '/' + taskId + '/' + id + '.' + (ext || 'jpg');

  // Texte de la notification « nouvelle tournée » : un lien, aucune information sensible
  const notifyText = url => 'מסלול חדש מחכה לך. לצפייה: ' + url;
  // SMS courts (hébreu = 70 caractères par SMS facturé)
  const otpText = code => 'קוד הכניסה שלך: ' + code + '. לא מעבירים אותו לאף אחד.';

  // ---------- accès par lien ----------
  // Décalage (minutes) d'un fuseau à un instant donné
  function tzOffsetMin(date, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
    const g = t => +p.find(x => x.type === t).value;
    return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - date.getTime()) / 60000);
  }
  // « 2026-11-02T18:00 » lu à l'heure d'Israël → instant ISO (UTC), quel que soit le fuseau de l'ordinateur
  function ilToUtcISO(local) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(local || ''));
    if (!m) return null;
    const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    let ts = guess - tzOffsetMin(new Date(guess), 'Asia/Jerusalem') * 60000;
    const off2 = tzOffsetMin(new Date(ts), 'Asia/Jerusalem');
    ts = guess - off2 * 60000;
    return new Date(ts).toISOString();
  }
  // instant → valeur d'un champ « date et heure » à l'heure d'Israël
  function utcToIlInput(iso) {
    const d = new Date(iso); if (isNaN(d)) return '';
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
  }
  // état d'un lien vu par l'équipe (le serveur, lui, revérifie tout à chaque appel)
  function linkState(link, trip, nowMs) {
    if (!link) return 'none';
    if (link.revoked_at) return 'revoked';
    if (Date.parse(link.expires_at) <= (nowMs == null ? Date.now() : nowMs)) return 'expired';
    if (trip && (!trip.publishedAt || trip.driverId !== link.driver_id)) return 'inactive';
    return 'active';
  }
  const LINK_STATES = {
    active:   { label: 'פעיל',      icon: 'check', tone: 'ok' },
    expired:  { label: 'פג תוקף',   icon: 'clock', tone: 'muted' },
    revoked:  { label: 'בוטל',      icon: 'block', tone: 'muted' },
    inactive: { label: 'לא פעיל',   icon: 'alert', tone: 'problem' }
  };
  // clé du lien dans l'adresse « …/driver#t=<clé> » (après #, jamais envoyée aux serveurs)
  const linkTokenFrom = hash => { const m = /[#&]t=([A-Za-z0-9_-]{40,64})(?:&|$)/.exec(String(hash || '')); return m ? m[1] : null; };
  const LINK_DEAD_TEXT = 'תוקף הקישור פג. יש לפנות לצוות לקבלת קישור חדש.';

  const api = { ilToUtcISO, utcToIlInput, linkState, LINK_STATES, linkTokenFrom, LINK_DEAD_TEXT, normalizePhone, displayPhone, STATUSES, FINAL, PROBLEMS, statusOf, statusInfo, isDone, isProblem, openProblem,
    checkStatusInput, orderStops, nextStop, progress, splitTrips, areaOf, authError, PROOF_STATES, proofPath, notifyText, otpText, NOTE_MIN };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Delivery = api;
})(typeof window !== 'undefined' ? window : this);
