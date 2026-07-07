const { thresholds } = require('./config');

// mint -> record
const tokens = new Map();

function getOrCreate(mint) {
  let rec = tokens.get(mint);
  if (!rec) {
    rec = {
      mint,
      firstSeenAt: Date.now(),
      lastTradeAt: Date.now(),
      presumedCreator: null,
      creatorHasSold: false,
      trades: [], // capped ring buffer, most recent last
      buyCount: 0,
      sellCount: 0,
      uniqueBuyers: new Set(),
      uniqueSellers: new Set(),
      totalSolBought: 0,
      totalSolSold: 0,
      latestBondingPct: 0,
      peakBondingPct: 0,
      alerted: false,
    };
    tokens.set(mint, rec);
  }
  return rec;
}

const MAX_TRADES_KEPT = 500;

function recordTrade(trade) {
  const rec = getOrCreate(trade.mint);

  if (!rec.presumedCreator) {
    // Best-effort only: the true creator should be confirmed via Helius DAS
    // getAsset before you trust this for anything consequential (see
    // dasLookup.js). We use "first wallet ever seen trading this mint" as a
    // placeholder since it's usually the creator's own opening buy.
    rec.presumedCreator = trade.trader;
  }
  if (trade.trader === rec.presumedCreator && !trade.isBuy) {
    rec.creatorHasSold = true;
  }

  rec.lastTradeAt = Date.now();
  rec.latestBondingPct = trade.bondingPct;
  rec.peakBondingPct = Math.max(rec.peakBondingPct, trade.bondingPct);

  if (trade.isBuy) {
    rec.buyCount += 1;
    rec.uniqueBuyers.add(trade.trader);
    rec.totalSolBought += trade.solAmount;
  } else {
    rec.sellCount += 1;
    rec.uniqueSellers.add(trade.trader);
    rec.totalSolSold += trade.solAmount;
  }

  rec.trades.push(trade);
  if (rec.trades.length > MAX_TRADES_KEPT) rec.trades.shift();

  return rec;
}

function markAlerted(mint) {
  const rec = tokens.get(mint);
  if (rec) rec.alerted = true;
}

function pruneStale() {
  const now = Date.now();
  for (const [mint, rec] of tokens.entries()) {
    if (now - rec.lastTradeAt > thresholds.tokenStaleMs) {
      tokens.delete(mint);
    }
  }
}

function stats() {
  return { trackedTokens: tokens.size };
}

module.exports = { getOrCreate, recordTrade, markAlerted, pruneStale, stats, tokens };
