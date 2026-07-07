const { PublicKey } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
const { PUMP_PROGRAM_ID, curve } = require('./config');
const logger = require('./logger');

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM_PUBKEY = new PublicKey(PUMP_PROGRAM_ID);

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
 * IMPORTANT: identifying which token-balance entry belongs to the bonding
 * curve (as opposed to the trader, or a fee/creator-reward account) is done
 * by computing the curve's associated token account address directly --
 * it's a deterministic PDA derived from the mint -- rather than by
 * elimination ("whichever entry isn't the trader's"). The elimination
 * approach can grab the wrong account when a tx has more than two
 * token-balance entries for the mint, which silently produces a wrong
 * bonding % (this was an actual bug caught in testing: a token still early
 * in its curve got miscalculated as almost graduated).
 */

// pump.fun's bonding curve PDA is derived deterministically per mint.
function deriveBondingCurveAta(mintPubkey) {
  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
    PUMP_PROGRAM_PUBKEY
  );
  const ata = getAssociatedTokenAddressSync(mintPubkey, bondingCurvePda, true);
  return { bondingCurvePda, ata };
}

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

    // --- Trader side: match by owner, as before -- this side isn't ambiguous.
    const traderEntry = {
      pre: pre.find((b) => b.owner === trader),
      post: post.find((b) => b.owner === trader),
    };

    // --- Curve side: match by exact derived account address, not elimination.
    let mintPubkey;
    try {
      mintPubkey = new PublicKey(mint);
    } catch {
      return null;
    }
    const { ata: bondingCurveAta } = deriveBondingCurveAta(mintPubkey);
    const bondingCurveAtaStr = bondingCurveAta.toBase58();

    const findByAccountIndex = (entries) =>
      entries.find((b) => accountKeys[b.accountIndex] === bondingCurveAtaStr);

    let curveEntry = {
      pre: findByAccountIndex(pre),
      post: findByAccountIndex(post),
    };

    if (!curveEntry.post) {
      // Fallback to the old elimination heuristic, but log it -- if this
      // fires often, the PDA derivation assumption needs re-checking
      // against a real captured payload.
      logger.warn(`Could not find bonding curve ATA by exact match for mint ${mint} -- falling back to heuristic.`);
      curveEntry = {
        pre: pre.find((b) => b.owner !== trader),
        post: post.find((b) => b.owner !== trader),
      };
    }
    if (!curveEntry.post) return null; // still nothing -- skip rather than guess wrong

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
