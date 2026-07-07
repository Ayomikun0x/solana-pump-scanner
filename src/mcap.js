const config = require('./config');

// Estimate USD market cap from bonding %. See config.js curve.GRADUATION_MCAP_USD_APPROX
// for the reasoning/caveats behind this approximation.
function estimateMcapUsd(bondingPct) {
  return (bondingPct / 100) * config.curve.GRADUATION_MCAP_USD_APPROX;
}

module.exports = { estimateMcapUsd };
