// Synchronisation Morning → CRM (voir api/_lib/handlers.js pour les règles d'accès).
const { syncHandler } = require('./_lib/handlers.js');
const { createSync } = require('./_lib/sync.js');
const { createMorning } = require('./_lib/morning.js');
const { createStore } = require('./_lib/store.js');

module.exports = (req, res) => {
  const env = process.env;
  const store = env.SUPABASE_SECRET_KEY ? createStore({ key: env.SUPABASE_SECRET_KEY }) : null;
  const sync = store ? createSync({ morning: createMorning({ clientId: env.MORNING_CLIENT_ID, clientSecret: env.MORNING_CLIENT_SECRET }), store }) : null;
  return syncHandler({ env, store, sync })(req, res);
};
