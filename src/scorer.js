/**
 * Scores a token (0-100) at the moment it crosses the bonding threshold.
 * Weights are a starting point -- tune them against pingcalls' historical
 * calls once you've got a few weeks of your own data logged.
 */
function scoreToken(rec) {
  const breakdown = [];
  let score = 0;

  // --- 1. Dev wallet behavior (25 pts) ---------------------------------
  // Heaviest weight: a creator dumping before/at graduation is the single
  // biggest red flag for a rug or a farmed graduation.
  if (rec.creatorHasSold) {
    breakdown.push({ label: 'Dev wallet sold', points: 0, max: 25, note: 'presumed creator sold at least once — high rug risk' });
  } else {
    breakdown.push({ label: 'Dev wallet clean', points: 25, max: 25, note: 'no sells detected from presumed creator wallet' });
    score += 25;
  }

  // --- 2. Buy/sell ratio (20 pts) --------------------------------------
  const totalTrades = rec.buyCount + rec.sellCount;
  const buyRatio = totalTrades > 0 ? rec.buyCount / totalTrades : 0;
  let ratioPts = 0;
  if (buyRatio >= 0.55 && buyRatio <= 0.85) {
    ratioPts = 20; // healthy: mostly buying, but some organic profit-taking
  } else if (buyRatio > 0.85) {
    ratioPts = 10; // almost nobody selling can mean no exit liquidity tested yet, or wash buys
  } else if (buyRatio >= 0.4) {
    ratioPts = 10; // heavier selling pressure already
  } else {
    ratioPts = 0; // more sells than buys this early = bad sign
  }
  score += ratioPts;
  breakdown.push({ label: 'Buy/sell ratio', points: ratioPts, max: 20, note: `${(buyRatio * 100).toFixed(0)}% of trades were buys` });

  // --- 3. Unique buyer distribution (25 pts) ----------------------------
  const uniqueBuyers = rec.uniqueBuyers.size;
  const buyerDiversity = rec.buyCount > 0 ? uniqueBuyers / rec.buyCount : 0;
  let diversityPts = 0;
  if (uniqueBuyers >= 30) diversityPts += 15;
  else if (uniqueBuyers >= 15) diversityPts += 10;
  else if (uniqueBuyers >= 8) diversityPts += 5;

  if (buyerDiversity >= 0.7) diversityPts += 10;
  else if (buyerDiversity >= 0.5) diversityPts += 5;
  score += diversityPts;
  breakdown.push({
    label: 'Buyer diversity',
    points: diversityPts,
    max: 25,
    note: `${uniqueBuyers} unique buyers across ${rec.buyCount} buys`,
  });

  // --- 4. Bonding velocity (20 pts) --------------------------------------
  const minutesToThreshold = (Date.now() - rec.firstSeenAt) / 60000;
  let velocityPts;
  let velocityNote;
  if (minutesToThreshold < 0.5) {
    velocityPts = 5; // suspiciously instant -- likely a single-wallet/bot-funded launch
    velocityNote = `graduated in ${minutesToThreshold.toFixed(2)}m — very fast, check for a single funding source`;
  } else if (minutesToThreshold <= 20) {
    velocityPts = 20; // strong organic momentum
    velocityNote = `graduated in ${minutesToThreshold.toFixed(1)}m — strong momentum`;
  } else if (minutesToThreshold <= 90) {
    velocityPts = 12;
    velocityNote = `graduated in ${minutesToThreshold.toFixed(1)}m — moderate momentum`;
  } else {
    velocityPts = 5;
    velocityNote = `graduated in ${minutesToThreshold.toFixed(1)}m — slow burn`;
  }
  score += velocityPts;
  breakdown.push({ label: 'Bonding velocity', points: velocityPts, max: 20, note: velocityNote });

  // --- 5. Volume sanity (10 pts) -----------------------------------------
  // Very few, very large buys suggest one whale is carrying the whole curve,
  // which usually means one wallet controls the exit.
  const avgBuySol = rec.buyCount > 0 ? rec.totalSolBought / rec.buyCount : 0;
  let volumePts = 10;
  let volumeNote = `avg buy size ${avgBuySol.toFixed(3)} SOL across ${rec.buyCount} buys`;
  if (rec.buyCount <= 5 && rec.totalSolBought > 20) {
    volumePts = 0;
    volumeNote += ' — very few large buys, whale-carried';
  } else if (rec.buyCount <= 10) {
    volumePts = 5;
  }
  score += volumePts;
  breakdown.push({ label: 'Volume distribution', points: volumePts, max: 10, note: volumeNote });

  return {
    score: Math.round(score),
    breakdown,
    buyRatio,
    uniqueBuyers,
    minutesToThreshold,
  };
}

module.exports = { scoreToken };
