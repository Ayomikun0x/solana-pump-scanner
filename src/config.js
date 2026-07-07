require('dotenv').config();

module.exports = {
  port: Number(process.env.PORT || 3000),

  webhookAuthSecret: process.env.WEBHOOK_AUTH_SECRET || '',

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },

  // pump.fun program (bonding curve / launchpad program)
  PUMP_PROGRAM_ID: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',

  // PumpSwap AMM program (tokens land here after graduating)
  PUMPSWAP_PROGRAM_ID: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',

  curve: {
    // Total tradable supply on the bonding curve (of the 1B total supply).
    // This lives in a mutable on-chain "Global" account pump.fun controls,
    // so it could technically drift if they retune the curve -- but this
    // is the current documented value.
    INITIAL_REAL_TOKEN_RESERVES: 793_100_000,
    // Real SOL raised at which the curve completes / graduates.
    // ~85 SOL / ~$69k mcap as of mid-2026. This drifts occasionally when
    // pump.fun tunes the curve -- treat it as an approximation.
    GRADUATION_SOL_APPROX: 85,
    // Market cap USD at 100% bonding, used to estimate mcap from bonding %
    // at alert time. Not a precise real-time price feed, but close enough
    // for a quick read since alerts only fire at 85%+ bonded.
    GRADUATION_MCAP_USD_APPROX: 69000,
  },

  thresholds: {
    alertBondingPct: Number(process.env.ALERT_BONDING_THRESHOLD || 85),
    minScoreToAlert: Number(process.env.MIN_SCORE_TO_ALERT || 65),
    tokenStaleMs: Number(process.env.TOKEN_STALE_MS || 3 * 60 * 60 * 1000),
  },

  paperTrading: {
    // How far above entry mcap counts as "hit the target" -- your 1.8-2x
    // exit goal, expressed as a multiple.
    exitTargetMultiple: Number(process.env.EXIT_TARGET_MULTIPLE || 1.8),
    // If it hasn't hit the target within this many hours, we call it a loss.
    maxHoldHours: Number(process.env.MAX_HOLD_HOURS || 24),
    // How often (ms) to check on all currently-open paper positions.
    checkIntervalMs: Number(process.env.PAPER_CHECK_INTERVAL_MS || 5 * 60 * 1000),
  },
};
