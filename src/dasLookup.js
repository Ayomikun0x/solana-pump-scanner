const logger = require('./logger');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

/**
 * Calls Helius's DAS getAsset RPC to fetch authoritative on-chain metadata,
 * including the creator array, for a mint. Only call this at the moment you
 * are about to alert (not per-trade) -- it costs an RPC credit each time.
 * Returns null on any failure so callers can fall back to the heuristic
 * presumedCreator on tokenState without crashing the pipeline.
 */
async function fetchCreatorFromDAS(mint) {
  if (!HELIUS_API_KEY) {
    logger.debug('HELIUS_API_KEY not set -- skipping DAS creator lookup.');
    return null;
  }
  const url = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'das-lookup',
        method: 'getAsset',
        params: { id: mint },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const creators = data && data.result && data.result.creators;
    if (Array.isArray(creators) && creators.length > 0) {
      return creators[0].address;
    }
    return null;
  } catch (err) {
    logger.warn('DAS lookup failed for', mint, err.message);
    return null;
  }
}

module.exports = { fetchCreatorFromDAS };
