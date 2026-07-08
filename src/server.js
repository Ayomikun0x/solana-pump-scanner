const express = require('express');
const config = require('./config');
const logger = require('./logger');
const tokenState = require('./tokenState');
const { parseWebhookBody } = require('./pumpEventParser');
const { scoreToken } = require('./scorer');
const { sendTelegramMessage, formatAlert } = require('./telegram');
const { fetchCreatorFromDAS } = require('./dasLookup');
const { estimateMcapUsd } = require('./mcap');
const paperTrader = require('./paperTrader');

const app = express();

// Helius payloads are small, but keep a generous-but-bounded limit.
app.use(express.json({ limit: '5mb' }));

// Diagnostic counters -- lets us see at a glance whether events are
// arriving and whether they're turning into recognized trades, instead of
// guessing blind next time something seems off.
const diagnostics = {
  webhookCallsReceived: 0,
  rawTxsInLastCall: 0,
  tradesParsedTotal: 0,
  tradesSkippedTotal: 0,
  lastWebhookAt: null,
};

app.get('/health', (req, res) => {
  res.json({ ok: true, ...tokenState.stats(), diagnostics });
});

app.get('/winrate', (req, res) => {
  const stats = paperTrader.winRateStats();
  const positions = paperTrader.getAllPositions();

  const rows = positions
    .map((p) => {
      const statusColor = p.status === 'win' ? '#2ecc71' : p.status === 'loss' ? '#e74c3c' : '#f39c12';
      const multiple = p.status === 'open' ? p.lastMultiple : p.finalMultiple;
      const multipleText = multiple != null ? `${multiple.toFixed(2)}x` : '—';
      return `<tr>
        <td><code>${p.mint.slice(0, 8)}...</code></td>
        <td>${new Date(p.entryTime).toLocaleString()}</td>
        <td>${p.entryScore}</td>
        <td style="color:${statusColor};font-weight:bold">${p.status.toUpperCase()}</td>
        <td>${multipleText}</td>
        <td>${p.maxMultiple.toFixed(2)}x</td>
      </tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
  <html>
  <head>
    <title>Win Rate</title>
    <style>
      body { font-family: -apple-system, sans-serif; background: #0d1117; color: #e6edf3; padding: 24px; }
      h1 { font-size: 20px; }
      .stat-box { display: inline-block; background: #161b22; border-radius: 8px; padding: 16px 20px; margin-right: 12px; margin-bottom: 20px; }
      .stat-box .num { font-size: 28px; font-weight: bold; }
      .stat-box .label { font-size: 13px; color: #8b949e; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #21262d; font-size: 14px; }
      th { color: #8b949e; font-weight: normal; }
      code { color: #79c0ff; }
    </style>
  </head>
  <body>
    <h1>Paper trading results</h1>
    <div>
      <div class="stat-box"><div class="num">${stats.winRatePct != null ? stats.winRatePct.toFixed(0) + '%' : '—'}</div><div class="label">Win rate</div></div>
      <div class="stat-box"><div class="num">${stats.wins}</div><div class="label">Wins</div></div>
      <div class="stat-box"><div class="num">${stats.losses}</div><div class="label">Losses</div></div>
      <div class="stat-box"><div class="num">${stats.open}</div><div class="label">Still open</div></div>
    </div>
    <table>
      <tr><th>Mint</th><th>Alerted at</th><th>Score</th><th>Status</th><th>Result</th><th>Peak</th></tr>
      ${rows || '<tr><td colspan="6">No alerts yet.</td></tr>'}
    </table>
    <p style="color:#8b949e;font-size:12px;margin-top:20px">Refresh this page anytime to see the latest. "Win" = hit ${config.paperTrading.exitTargetMultiple}x within ${config.paperTrading.maxHoldHours}h of the alert. This is simulated -- no real trades were placed.</p>
  </body>
  </html>`;

  res.send(html);
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

  diagnostics.webhookCallsReceived += 1;
  diagnostics.lastWebhookAt = new Date().toISOString();
  const rawCount = Array.isArray(req.body) ? req.body.length : 1;
  diagnostics.rawTxsInLastCall = rawCount;

  try {
    const trades = parseWebhookBody(req.body);
    diagnostics.tradesParsedTotal += trades.length;
    diagnostics.tradesSkippedTotal += rawCount - trades.length;
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

    // Start paper-tracking this one so we can measure win rate over time.
    paperTrader.openPosition({
      mint: rec.mint,
      entryScore: result.score,
      entryMcapUsd: estimateMcapUsd(rec.latestBondingPct),
    });
  } else {
    logger.info(`${rec.mint} did not meet min score (${config.thresholds.minScoreToAlert}) -- skipped.`);
  }
}

setInterval(() => tokenState.pruneStale(), 15 * 60 * 1000).unref();

setInterval(() => {
  paperTrader.checkOpenPositions().catch((err) => logger.error('Error checking open paper positions:', err));
}, config.paperTrading.checkIntervalMs).unref();

// Daily win-rate digest to Telegram.
setInterval(() => {
  const stats = paperTrader.winRateStats();
  if (stats.closed === 0) return; // nothing resolved yet, skip the noise
  const winRateText = stats.winRatePct != null ? `${stats.winRatePct.toFixed(0)}%` : 'n/a';
  const message = [
    `📊 <b>Daily win-rate digest</b>`,
    ``,
    `Win rate: <b>${winRateText}</b> (${stats.wins}W / ${stats.losses}L, ${stats.closed} closed)`,
    `Still tracking: ${stats.open} open positions`,
  ].join('\n');
  sendTelegramMessage(message).catch((err) => logger.error('Failed to send daily digest:', err));
}, 24 * 60 * 60 * 1000).unref();

app.listen(config.port, () => {
  logger.info(`Pump graduation scanner listening on port ${config.port}`);
  logger.info(`Webhook endpoint: POST /webhook/pump`);
});
