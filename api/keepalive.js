// Visite automatique pour empêcher la mise en pause de Supabase.
// Le projet Supabase gratuit est mis en pause après 7 jours sans activité.
// Vercel appelle cette adresse deux fois par semaine (voir "crons" dans vercel.json) :
// elle lit une ligne de la table customers, ce qui compte comme une activité.
const SUPABASE_URL = 'https://fryxliuhaayyedmskohm.supabase.co';
const SUPABASE_KEY = 'sb_publishable_czw0QR_TnL5SY_Rjaq7lrw_q55YRGny'; // clé publique, la même que dans index.html

module.exports = async (req, res) => {
  const at = new Date().toISOString();
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/customers?select=id&limit=1`, {
      headers: { apikey: SUPABASE_KEY }
    });
    // 502 = Supabase n'a pas répondu correctement : visible dans les logs Vercel
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, supabaseStatus: r.status, at });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.cause ? e.cause : e), at });
  }
};
