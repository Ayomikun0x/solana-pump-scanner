# Solana Pump.fun Graduation Scanner

Watches pump.fun bonding curves via a Helius webhook, scores tokens once they
cross 85% bonding, and fires a Telegram alert for the ones that pass your filters.

## How it works

```
pump.fun program activity
        │
        ▼
Helius RAW webhook (filtered on the pump.fun program address)
        │  POST
        ▼
Express server  (src/server.js)
  ├─ pumpEventParser.js   → turns raw tx into a {mint, isBuy, solAmount, bondingPct, ...} trade
  ├─ tokenState.js         → in-memory per-mint stats (buys/sells/unique buyers/dev wallet)
  ├─ scorer.js             → scores 0-100 once bondingPct crosses ALERT_BONDING_THRESHOLD
  └─ telegram.js           → sends the alert if score >= MIN_SCORE_TO_ALERT
```

**Why raw webhooks, not Enhanced webhooks:** Helius's Enhanced webhook parsing
covers ~100 known transaction types (NFT sales, common DeFi swaps, transfers,
etc.) but doesn't have a native pump.fun swap type. So we use a Raw webhook
(full unparsed transaction data) and derive trades ourselves from balance
deltas — which side of the trade the SOL and tokens moved on. This is more
robust than hand-decoding the anchor event bytes in the program logs, since
it doesn't depend on guessing an exact struct layout.

**Bonding curve math:** progress is computed from how many of the 800M
tradable tokens are still sitting in the curve's own token account:
`100 - (tokensLeftInCurve * 100 / 800,000,000)`. Graduation happens at 100%,
roughly ~85 SOL raised / ~$69k market cap as of mid-2026 — but that SOL figure
drifts occasionally when pump.fun tunes curve parameters, so the token-based
formula above is what the code actually uses, not a hardcoded SOL amount.

## Setup

### 1. Helius account + webhook

1. Sign up at [helius.dev](https://helius.dev), grab your API key.
2. Dashboard → Webhooks → Create Webhook:
   - **Webhook type:** Raw
   - **Addresses to monitor:** `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (pump.fun program)
   - **Transaction type:** ANY (raw webhooks don't filter by type anyway)
   - **Webhook URL:** `https://<your-deployed-url>/webhook/pump`
   - **Auth Header:** set this to the same string you'll use for `WEBHOOK_AUTH_SECRET` below
3. Free tier gives you a real webhook allotment to start with — watch your
   credit usage on the dashboard once you're live, since every delivered
   event costs 1 credit regardless of whether your server does anything with it.

### 2. Telegram bot

1. Message [@BotFather](https://t.me/BotFather), `/newbot`, grab the token.
2. Add the bot to your alert channel/group, send it any message, then hit
   `https://api.telegram.org/bot<TOKEN>/getUpdates` to find the `chat.id`.

### 3. Local env

```bash
cp .env.example .env
# fill in HELIUS_API_KEY, WEBHOOK_AUTH_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
npm install
npm start
```

### 4. Verify the parser before going live

Point the Helius webhook at a scratch endpoint first (e.g.
[webhook.site](https://webhook.site)), grab one real payload, save it as
`sample.json`, then:

```bash
node src/tools/replayLog.js sample.json
```

This prints exactly what the parser extracts (mint, buy/sell, SOL amount,
bonding %) so you can sanity-check it against what you see on pump.fun /
Solscan for that transaction before trusting it in production. This is the
one step I'd genuinely treat as required, not optional — I built the parser
from documented balance-delta behavior, but pump.fun's exact account layout
in a live payload is worth eyeballing once before you rely on it for alerts.

### 5. Deploy

Same shape as the Base bot: push to a fresh Railway project (or Render/Fly),
set the env vars in the dashboard, expose the port, and put the public URL
into the Helius webhook config.

## Tuning

- `ALERT_BONDING_THRESHOLD` — % bonding at which we score (default 85)
- `MIN_SCORE_TO_ALERT` — minimum score 0-100 to actually fire a Telegram
  message (default 65) — start conservative, loosen once you've compared a
  couple weeks of alerts against outcomes
- Scoring weights live in `src/scorer.js` — five components (dev wallet
  behavior, buy/sell ratio, buyer diversity, bonding velocity, volume
  distribution), each with a short rationale comment. Worth cross-checking
  your first batch of alerts against calls in `t.me/pingcalls` and adjusting
  weights toward whatever actually correlates with tokens holding above your
  1.8-2x exit target.

## Known limitations / things to revisit

- **Dev wallet detection** starts as a heuristic (first wallet seen trading
  the mint) and gets upgraded to the real on-chain creator via a Helius DAS
  `getAsset` call once a token crosses threshold — this costs one extra RPC
  call per scored token, not per trade, so it's cheap.
- **State is in-memory only.** A restart loses all in-flight token tracking.
  Fine for a single-instance Railway deploy; if you want alerts to survive
  redeploys, swap `tokenState.js`'s Map for Redis or SQLite — the interface
  (`getOrCreate`/`recordTrade`/`markAlerted`) is small enough to reimplement
  against either without touching the rest of the pipeline.
- **No persistent trade log / Sheets export yet** — the Base bot has Google
  Sheets logging; happy to add the same here once the scoring is dialed in,
  so you're not building analytics on top of a moving target.
- **SOL/USD pricing isn't wired in** — alerts currently show bonding % and
  SOL amounts, not a USD market cap number. Easy to add (Jupiter or CoinGecko
  price endpoint, cached ~60s) once you want it in the alert text.
