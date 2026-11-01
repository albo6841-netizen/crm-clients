// Étape 2 : réception d'une signature liée à un document précis (voir api/_lib/signature.js).
const { cleanEnv } = require('./_lib/handlers.js');
const { driverSignHandler } = require('./_lib/signature.js');
const { createDriverStore } = require('./_lib/drivers-store.js');

module.exports = (req, res) => {
  const env = cleanEnv(process.env);
  const store = env.SUPABASE_SECRET_KEY ? createDriverStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  return driverSignHandler({ env, store })(req, res);
};
