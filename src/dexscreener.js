const logger = require('./logger');

/**
 * DexScreener has a free, no-API-key endpoint that covers PumpSwap pools
 * (where pump.fun tokens land once they graduate). We use it purely to
 * check in on tokens AFTER an alert, to see whether they went on to hit
 * the exit target -- not for the original bonding-curve tracking, which
 * comes from Helius.
 */
async function fetchTokenMarketData(mint) {
  const url = `https://api.dexscreener.com/latest/dex/tokens/${mint}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data && data.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // A token can have multiple pools; take the one with the most liquidity
    // as the most representative price.
    const best = pairs.reduce((a, b) => {
      const aLiq = (a && a.liquidity && a.liquidity.usd) || 0;
      const bLiq = (b && b.liquidity && b.liquidity.usd) || 0;
      return bLiq > aLiq ? b : a;
    });

    const mcapUsd = best.fdv || best.marketCap || null;
    const priceUsd = best.priceUsd ? Number(best.priceUsd) : null;
    if (!mcapUsd) return null;

    return { mcapUsd, priceUsd, pairUrl: best.url || null };
  } catch (err) {
    logger.debug('DexScreener lookup failed for', mint, err.message);
    return null;
  }
}

module.exports = { fetchTokenMarketData };
