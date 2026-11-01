// SMS de connexion des livreurs : appelé par Supabase Auth (crochet « Send SMS »), voir api/_lib/drivers.js.
const { cleanEnv } = require('./_lib/handlers.js');
const { smsHookHandler } = require('./_lib/drivers.js');
const { createDriverStore } = require('./_lib/drivers-store.js');
const { createSms } = require('./_lib/sms.js');

module.exports = (req, res) => {
  const env = cleanEnv(process.env);
  const store = env.SUPABASE_SECRET_KEY ? createDriverStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  return smsHookHandler({ env, store, sms: createSms({ env }) })(req, res);
};
