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

// Tracks transaction signatures we've already processed, so a Helius
// redelivery of the same event (their docs warn this can happen) doesn't
// get counted or alerted on twice. Simple bounded FIFO -- no need for
// anything fancier at this volume.
const processedSignatures = new Set();
const MAX_SIG_CACHE = 5000;
function alreadyProcessed(signature) {
  if (!signature) return false;
  if (processedSignatures.has(signature)) return true;
  processedSignatures.add(signature);
  if (processedSignatures.size > MAX_SIG_CACHE) {
    const oldest = processedSignatures.values().next().value;
    processedSignatures.delete(oldest);
  }
  return false;
}

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
      if (alreadyProcessed(trade.signature)) {
        logger.debug('Skipping already-processed signature', trade.signature);
        continue;
      }
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

  // Claim this token IMMEDIATELY, before any awaits. Multiple trades for
  // the same mint can arrive within milliseconds of each other right as it
  // crosses threshold -- without claiming synchronously here, two of them
  // could both see rec.alerted === false and both go on to send an alert.
  tokenState.markAlerted(rec.mint);

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
  } else {
    logger.info(`${rec.mint} did not meet min score (${config.thresholds.minScoreToAlert}) -- skipped.`);
  }
}

setInterval(() => tokenState.pruneStale(), 15 * 60 * 1000).unref();

app.listen(config.port, () => {
  logger.info(`Pump graduation scanner listening on port ${config.port}`);
  logger.info(`Webhook endpoint: POST /webhook/pump`);
});
