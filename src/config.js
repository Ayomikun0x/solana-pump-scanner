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
    INITIAL_REAL_TOKEN_RESERVES: 800_000_000,
    // Real SOL raised at which the curve completes / graduates.
    // ~85 SOL / ~$69k mcap as of mid-2026. This drifts occasionally when
    // pump.fun tunes the curve — treat it as an approximation and prefer
    // computing progress from realTokenReserves when you have it (see
    // scorer.js), not from a hardcoded SOL number.
    GRADUATION_SOL_APPROX: 85,
  },

  thresholds: {
    alertBondingPct: Number(process.env.ALERT_BONDING_THRESHOLD || 85),
    minScoreToAlert: Number(process.env.MIN_SCORE_TO_ALERT || 65),
    tokenStaleMs: Number(process.env.TOKEN_STALE_MS || 3 * 60 * 60 * 1000),
  },
};
