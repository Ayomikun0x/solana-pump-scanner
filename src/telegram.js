const { telegram } = require('./config');
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

function formatAlert({ rec, result }) {
  const { score, breakdown, buyRatio, uniqueBuyers, minutesToThreshold } = result;
  const pct = rec.latestBondingPct.toFixed(1);
  const solscan = `https://solscan.io/token/${rec.mint}`;
  const pumpfun = `https://pump.fun/coin/${rec.mint}`;

  const lines = [
    `🎓 <b>Graduation Alert</b> — score <b>${score}/100</b>`,
    `<code>${rec.mint}</code>`,
    ``,
    `Bonding: ${pct}% | Buys: ${rec.buyCount} | Sells: ${rec.sellCount} | Unique buyers: ${uniqueBuyers}`,
    `Time to threshold: ${minutesToThreshold.toFixed(1)}m | Buy ratio: ${(buyRatio * 100).toFixed(0)}%`,
    `Dev wallet sold: ${rec.creatorHasSold ? '⚠️ YES' : '✅ no'}`,
    ``,
    `<b>Breakdown</b>`,
    ...breakdown.map((b) => `• ${b.label}: ${b.points}/${b.max} — ${b.note}`),
    ``,
    `<a href="${pumpfun}">pump.fun</a> | <a href="${solscan}">Solscan</a>`,
  ];
  return lines.join('\n');
}

module.exports = { sendTelegramMessage, formatAlert };
