// Accès temporaire à une tournée par lien privé (voir api/_lib/link.js).
const { cleanEnv } = require('./_lib/handlers.js');
const { linkHandler } = require('./_lib/link.js');
const { createDriverStore } = require('./_lib/drivers-store.js');

module.exports = (req, res) => {
  const env = cleanEnv(process.env);
  const store = env.SUPABASE_SECRET_KEY ? createDriverStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  return linkHandler({ env, store })(req, res);
};
