// Envoi de SMS réels par Twilio (rien n'est simulé).
// Tant que les clés Twilio ne sont pas posées sur Vercel, configured() est faux et rien n'est envoyé.
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   et TWILIO_FROM (nom d'expéditeur, ex. « Masloulim », ou numéro +1…) ou TWILIO_MESSAGING_SERVICE_SID
function createSms({ env, fetchImpl = fetch }) {
  const sid = env.TWILIO_ACCOUNT_SID, token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM, service = env.TWILIO_MESSAGING_SERVICE_SID;
  const configured = () => Boolean(sid && token && (from || service));

  // to : numéro international « +972… ». Renvoie l'identifiant Twilio, ou lance une erreur lisible.
  async function send(to, body) {
    if (!configured()) { const e = new Error('sms_not_configured'); e.code = 'not_configured'; throw e; }
    const form = new URLSearchParams({ To: to, Body: body });
    if (service) form.set('MessagingServiceSid', service); else form.set('From', from);
    const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error('sms_failed: ' + (j.message || r.status)); e.code = 'failed'; throw e; }
    return j.sid || '';
  }
  return { configured, send };
}

module.exports = { createSms };
