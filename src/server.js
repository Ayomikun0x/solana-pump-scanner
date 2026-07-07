const express = require('express');
const config = require('./config');
const logger = require('./logger');
const tokenState = require('./tokenState');
const { parseWebhookBody } = require('./pumpEventParser');
const { scoreToken } = require('./scorer');
const { sendTelegramMessage, formatAlert } = require('./telegram');
const { fetchCreatorFromDAS } = require('./dasLookup');

const app = express();

// Helius payloads are small, but keep a generous-but-bounded limit.
app.use(express.json({ limit: '5mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true, ...tokenState.stats() });
});

app.post('/webhook/pump', async (req, res) => {
  // Verify the shared secret you set in the Helius webhook config's
  // "Auth Header" field. Helius echoes it back as the Authorization header.
  if (config.webhookAuthSecret) {
    const auth = req.get('Authorization');
    if (auth !== config.webhookAuthSecret) {
      logger.warn('Rejected webhook call with bad/missing auth header.');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // Ack immediately -- Helius wants a 200 within ~1s, do the work after.
  res.status(200).json({ received: true });

  try {
    const trades = parseWebhookBody(req.body);
    for (const trade of trades) {
      await handleTrade(trade);
    }
  } catch (err) {
    logger.error('Error processing webhook body:', err);
  }
});

async function handleTrade(trade) {
  const rec = tokenState.recordTrade(trade);

  if (rec.alerted) return; // already alerted for this mint, don't spam
  if (rec.latestBondingPct < config.thresholds.alertBondingPct) return;

  logger.info(`${rec.mint} crossed ${config.thresholds.alertBondingPct}% bonding -- scoring...`);

  // Confirm the real creator via Helius DAS before scoring the "dev
  // behavior" component off just the heuristic guess, when possible.
  const confirmedCreator = await fetchCreatorFromDAS(rec.mint);
  if (confirmedCreator) {
    rec.presumedCreator = confirmedCreator;
    rec.creatorHasSold = rec.trades.some((t) => t.trader === confirmedCreator && !t.isBuy);
  }

  const result = scoreToken(rec);
  logger.info(`${rec.mint} scored ${result.score}/100`);

  if (result.score >= config.thresholds.minScoreToAlert) {
    const message = formatAlert({ rec, result });
    await sendTelegramMessage(message);
    tokenState.markAlerted(rec.mint);
  } else {
    // Mark alerted anyway so we don't re-score this mint every single trade
    // once it's past threshold and already failed -- but log it so you can
    // review misses later and re-tune weights.
    tokenState.markAlerted(rec.mint);
    logger.info(`${rec.mint} did not meet min score (${config.thresholds.minScoreToAlert}) -- skipped.`);
  }
}

setInterval(() => tokenState.pruneStale(), 15 * 60 * 1000).unref();

app.listen(config.port, () => {
  logger.info(`Pump graduation scanner listening on port ${config.port}`);
  logger.info(`Webhook endpoint: POST /webhook/pump`);
});
