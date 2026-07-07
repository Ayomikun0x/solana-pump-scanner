const config = require('./config');
const { telegram } = config;
const logger = require('./logger');

async function sendTelegramMessage(text) {
  if (!telegram.botToken || !telegram.chatId) {
    logger.warn('Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing) -- skipping send.');
    return;
  }
  const url = `https://api.telegram.org/bot${telegram.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      logger.error('Telegram send failed:', res.status, body);
    }
  } catch (err) {
    logger.error('Telegram send error:', err.message);
  }
}

function verdictFor(score) {
  if (score >= 85) return '🟢 Strong — clean signals across the board';
  if (score >= 75) return '🟡 Good — worth a closer look';
  return '🟠 Passed the bar, but not by much — check it carefully';
}

function formatUSD(n) {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function formatAlert({ rec, result }) {
  const { score, buyRatio, uniqueBuyers, minutesToThreshold } = result;
  const pct = rec.latestBondingPct.toFixed(1);
  const mcapEstimate = (rec.latestBondingPct / 100) * config.curve.GRADUATION_MCAP_USD_APPROX;
  const solscan = `https://solscan.io/token/${rec.mint}`;
  const pumpfun = `https://pump.fun/coin/${rec.mint}`;

  const lines = [
    `🎓 <b>A token just hit graduation zone</b>`,
    ``,
    `${verdictFor(score)} (score: ${score}/100)`,
    ``,
    `Address (tap to copy):`,
    `<code>${rec.mint}</code>`,
    ``,
    `<b>What's going on:</b>`,
    `• ~${formatUSD(mcapEstimate)} estimated market cap`,
    `• ${pct}% bonded (graduates at 100%)`,
    `• ${rec.buyCount} people bought, ${rec.sellCount} sold (${(buyRatio * 100).toFixed(0)}% of trades were buys)`,
    `• ${uniqueBuyers} different wallets bought in — good sign, not just one group`,
    `• Took ${minutesToThreshold.toFixed(1)} minutes to get this far`,
    `• Creator wallet sold already: ${rec.creatorHasSold ? '⚠️ yes — a red flag' : '✅ no'}`,
    ``,
    `This passed our filters but always check the chart yourself first.`,
    `<a href="${pumpfun}">View on pump.fun</a> | <a href="${solscan}">View on Solscan</a>`,
  ];
  return lines.join('\n');
}

module.exports = { sendTelegramMessage, formatAlert };
