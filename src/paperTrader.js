const config = require('./config');
const logger = require('./logger');
const { fetchTokenMarketData } = require('./dexscreener');

// mint -> position
const positions = new Map();

function openPosition({ mint, entryScore, entryMcapUsd }) {
  if (positions.has(mint)) return; // already tracking this one
  positions.set(mint, {
    mint,
    entryScore,
    entryMcapUsd,
    entryTime: Date.now(),
    maxMultiple: 1,
    lastMultiple: null,
    lastCheckedAt: null,
    checks: 0,
    status: 'open', // 'open' | 'win' | 'loss'
    closedAt: null,
    finalMultiple: null,
  });
  logger.info(`Paper trade opened for ${mint} at ~$${Math.round(entryMcapUsd).toLocaleString('en-US')} mcap`);
}

function getOpenPositions() {
  return [...positions.values()].filter((p) => p.status === 'open');
}

function getAllPositions() {
  return [...positions.values()].sort((a, b) => b.entryTime - a.entryTime);
}

async function checkOpenPositions() {
  const open = getOpenPositions();
  for (const pos of open) {
    pos.checks += 1;
    const data = await fetchTokenMarketData(pos.mint);

    if (data && data.mcapUsd) {
      const multiple = data.mcapUsd / pos.entryMcapUsd;
      pos.lastMultiple = multiple;
      pos.lastCheckedAt = Date.now();
      pos.maxMultiple = Math.max(pos.maxMultiple, multiple);

      if (multiple >= config.paperTrading.exitTargetMultiple) {
        pos.status = 'win';
        pos.closedAt = Date.now();
        pos.finalMultiple = multiple;
        logger.info(`Paper trade WIN for ${pos.mint} -- hit ${multiple.toFixed(2)}x`);
        continue;
      }
    }

    const ageHours = (Date.now() - pos.entryTime) / 3600000;
    if (ageHours >= config.paperTrading.maxHoldHours) {
      pos.status = 'loss';
      pos.closedAt = Date.now();
      pos.finalMultiple = pos.lastMultiple ?? 1;
      logger.info(`Paper trade LOSS (timed out) for ${pos.mint} -- best it reached was ${pos.maxMultiple.toFixed(2)}x`);
    }
  }
}

function winRateStats() {
  const all = getAllPositions();
  const closed = all.filter((p) => p.status !== 'open');
  const wins = closed.filter((p) => p.status === 'win').length;
  const losses = closed.filter((p) => p.status === 'loss').length;
  return {
    open: all.length - closed.length,
    closed: closed.length,
    wins,
    losses,
    winRatePct: closed.length > 0 ? (wins / closed.length) * 100 : null,
  };
}

module.exports = { openPosition, getOpenPositions, getAllPositions, checkOpenPositions, winRateStats };
