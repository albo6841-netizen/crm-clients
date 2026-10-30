// Lance la synchro Morning → CRM depuis cet ordinateur (premier import, ou test sur un client).
// Les clés sont lues dans Documents\claude (hors du dépôt) :
//   .morning-keys.txt   → MORNING_CLIENT_ID=… / MORNING_CLIENT_SECRET=…
//   .supabase-secret.txt → la clé secrète Supabase (sb_secret_…)
// Exemples :
//   node scripts/morning-sync-local.js --customer <id de la fiche CRM>
//   node scripts/morning-sync-local.js --all
const fs = require('fs');
const path = require('path');
const { createSync } = require('../api/_lib/sync.js');
const { createMorning } = require('../api/_lib/morning.js');
const { createStore } = require('../api/_lib/store.js');

const DIR = path.join(__dirname, '..', '..');
const kv = Object.fromEntries(fs.readFileSync(path.join(DIR, '.morning-keys.txt'), 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
// on enlève espaces et retours à la ligne (une clé copiée-collée peut être coupée en deux lignes)
const secret = fs.readFileSync(path.join(DIR, '.supabase-secret.txt'), 'utf8').replace(/\s+/g, '');

const args = process.argv.slice(2);
const customerId = args.includes('--customer') ? args[args.indexOf('--customer') + 1] : undefined;
if (!customerId && !args.includes('--all')) { console.log('Préciser --customer <id> ou --all'); process.exit(1); }

const store = createStore({ key: secret });
const sync = createSync({ morning: createMorning({ clientId: kv.MORNING_CLIENT_ID, clientSecret: kv.MORNING_CLIENT_SECRET }), store });
const t0 = Date.now();
sync.syncAll({ customerId, maxPdf: 2000 })
  .then(r => console.log('OK', JSON.stringify(r), 'en', Math.round((Date.now() - t0) / 1000), 's'))
  .catch(e => { console.error('ÉCHEC', e.message); process.exit(1); });
