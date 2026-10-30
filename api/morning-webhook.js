// Alertes Morning « document créé » (configurées dans Morning → כלים למפתחים → Webhooks).
const { webhookHandler, cleanEnv } = require('./_lib/handlers.js');
const { createSync } = require('./_lib/sync.js');
const { createMorning } = require('./_lib/morning.js');
const { createStore } = require('./_lib/store.js');

module.exports = (req, res) => {
  const env = cleanEnv(process.env);
  const store = env.SUPABASE_SECRET_KEY ? createStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  const sync = store ? createSync({ morning: createMorning({ clientId: env.MORNING_CLIENT_ID, clientSecret: env.MORNING_CLIENT_SECRET }), store }) : null;
  return webhookHandler({ env, sync })(req, res);
};
