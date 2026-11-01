// Espace livreurs : gestion des livreurs et notification « nouvelle tournée » (voir api/_lib/drivers.js).
const { cleanEnv } = require('./_lib/handlers.js');
const { driversHandler } = require('./_lib/drivers.js');
const { createDriverStore } = require('./_lib/drivers-store.js');
const { createSms } = require('./_lib/sms.js');

module.exports = (req, res) => {
  const env = cleanEnv(process.env);
  const store = env.SUPABASE_SECRET_KEY ? createDriverStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  return driversHandler({ env, store, sms: createSms({ env }) })(req, res);
};
