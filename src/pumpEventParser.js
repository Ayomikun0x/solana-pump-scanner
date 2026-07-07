const { PUMP_PROGRAM_ID, curve } = require('./config');
const logger = require('./logger');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * NOTE ON APPROACH
 * -----------------
 * Helius "Enhanced" webhooks don't have a built-in pump.fun swap type, so we
 * subscribe to a RAW webhook filtered on the pump.fun program address and
 * parse trades ourselves from balance deltas (preTokenBalances/postTokenBalances,
 * preBalances/postBalances) rather than hand-decoding the anchor event bytes
 * in the program logs. Balance deltas are stable across program upgrades and
 * don't require guessing struct field order/discriminators.
 *
 * A pump.fun buy/sell instruction moves tokens between exactly two token
 * accounts for the mint: the trader's ATA and the bonding curve's ATA. We
 * identify the curve side as "whichever entry isn't the trader's." If a
 * transaction ever has MORE than two balance entries for the mint (some
 * unexpected extra account), we deliberately skip it rather than guess which
 * one is the curve -- an earlier version of this code guessed in that case,
 * which risked misreading bonding % on ambiguous transactions.
 */

function normalizeAccountKeys(message) {
  if (!message || !message.accountKeys) return [];
  return message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
}

function txInvolvesPump(accountKeys) {
  return accountKeys.includes(PUMP_PROGRAM_ID);
}

function findMintBalanceEntries(preTokenBalances, postTokenBalances, mint) {
  const pre = (preTokenBalances || []).filter((b) => b.mint === mint);
  const post = (postTokenBalances || []).filter((b) => b.mint === mint);
  return { pre, post };
}

function uiAmount(entry) {
  if (!entry) return 0;
  if (entry.uiTokenAmount && typeof entry.uiTokenAmount.uiAmount === 'number') {
    return entry.uiTokenAmount.uiAmount;
  }
  return 0;
}

/**
 * Parses a single raw transaction object (as delivered by a Helius raw
 * webhook) into a normalized trade event, or returns null if it isn't a
 * pump.fun buy/sell we care about.
 */
function parsePumpTrade(rawTx) {
  try {
    const tx = rawTx.transaction;
    const meta = rawTx.meta;
    if (!tx || !meta || meta.err) return null; // skip failed txs

    const accountKeys = normalizeAccountKeys(tx.message);
    if (!txInvolvesPump(accountKeys)) return null;

    const trader = accountKeys[0]; // fee payer; pump.fun buy/sell requires the user to sign
    const signature = rawTx.signature || (rawTx.transaction.signatures && rawTx.transaction.signatures[0]);

    // Find the non-WSOL mint involved -- that's our token.
    const allMints = new Set([
      ...(meta.preTokenBalances || []).map((b) => b.mint),
      ...(meta.postTokenBalances || []).map((b) => b.mint),
    ]);
    allMints.delete(WSOL_MINT);
    if (allMints.size === 0) return null;
    // In a normal pump.fun buy/sell there is exactly one non-WSOL mint.
    // If there's more than one (e.g. an unrelated bundled ix), bail rather than guess.
    if (allMints.size > 1) return null;
    const mint = [...allMints][0];

    const { pre, post } = findMintBalanceEntries(meta.preTokenBalances, meta.postTokenBalances, mint);
    if (post.length === 0) return null;

    // Safety check: a normal buy/sell has exactly two balance entries for
    // this mint (trader + curve). If there are more, something unexpected
    // is going on (an extra account we don't recognize) -- skip rather
    // than risk misidentifying which one is the curve.
    if (pre.length > 2 || post.length > 2) {
      logger.debug(`Skipping tx with ${post.length} balance entries for mint ${mint} -- ambiguous, not the usual 2-party swap.`);
      return null;
    }

    const traderEntry = {
      pre: pre.find((b) => b.owner === trader),
      post: post.find((b) => b.owner === trader),
    };
    const curveEntry = {
      pre: pre.find((b) => b.owner !== trader),
      post: post.find((b) => b.owner !== trader),
    };
    if (!curveEntry.post) return null; // can't find the curve side, skip

    const traderPreAmt = uiAmount(traderEntry.pre);
    const traderPostAmt = uiAmount(traderEntry.post);
    const tokenDelta = traderPostAmt - traderPreAmt;
    if (tokenDelta === 0) return null; // no actual token movement for the trader

    const isBuy = tokenDelta > 0;

    // SOL side: fee payer's lamport delta, net of the network fee.
    const feePayerIdx = 0;
    const preLamports = (meta.preBalances || [])[feePayerIdx] || 0;
    const postLamports = (meta.postBalances || [])[feePayerIdx] || 0;
    const fee = meta.fee || 0;
    const lamportDelta = postLamports - preLamports + fee; // add back the fee so it doesn't pollute the trade size
    const solAmount = Math.abs(lamportDelta) / 1e9;

    const leftTokens = uiAmount(curveEntry.post);
    const bondingPct = Math.max(
      0,
      Math.min(100, 100 - (leftTokens * 100) / curve.INITIAL_REAL_TOKEN_RESERVES)
    );

    return {
      signature,
      mint,
      trader,
      isBuy,
      tokenAmount: Math.abs(tokenDelta),
      solAmount,
      curveTokensRemaining: leftTokens,
      bondingPct,
      blockTime: rawTx.blockTime || Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    logger.warn('Failed to parse tx as pump trade:', err.message);
    return null;
  }
}

/**
 * Helius raw webhooks POST an array of transaction objects.
 */
function parseWebhookBody(body) {
  const txs = Array.isArray(body) ? body : [body];
  const trades = [];
  for (const rawTx of txs) {
    const trade = parsePumpTrade(rawTx);
    if (trade) trades.push(trade);
  }
  return trades;
}

module.exports = { parseWebhookBody, parsePumpTrade };
