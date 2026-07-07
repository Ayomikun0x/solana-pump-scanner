/**
 * Usage: node src/tools/replayLog.js path/to/captured-webhook-payload.json
 *
 * Grab a real payload first by pointing your Helius webhook at
 * https://webhook.site temporarily (or logging req.body in server.js to a
 * file for one request), save the JSON body it received, then run this to
 * see exactly what the parser extracts from it -- without needing Telegram
 * or a public URL wired up yet.
 */
const fs = require('fs');
const path = require('path');
const { parseWebhookBody } = require('../pumpEventParser');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node src/tools/replayLog.js <path-to-payload.json>');
  process.exit(1);
}

const body = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const trades = parseWebhookBody(body);

console.log(`Parsed ${trades.length} trade(s) from ${Array.isArray(body) ? body.length : 1} transaction(s):\n`);
for (const t of trades) {
  console.log(JSON.stringify(t, null, 2));
}
if (trades.length === 0) {
  console.log('No trades parsed. If you expected some, check:');
  console.log('  - does the tx actually include the pump.fun program in accountKeys?');
  console.log('  - did meta.err come back non-null (failed tx)?');
  console.log('  - are preTokenBalances/postTokenBalances present in this payload?');
}
