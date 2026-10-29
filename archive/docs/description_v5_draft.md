<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] v5.0 architecture (DRAFT — foundation, for discussion)
## Autonomous scanner: Bybit API as the only data source

> Retired draft. Never implemented as designed — the SMC family itself
> was later rejected and the autonomous-scanner idea was reincarnated
> on a different strategy (Donchian, see STRATEGY.md).

Status: **proposal, never implemented**. Deferred pending v4.3 burn-in
and statistics from real TradingView alerts. The document records the
agreed design: the goal is effective profit, not the letter of
conditions.

---

## 0. Transition: driven → driving system

v4.3 was armoured but **driven**: it waited for a TV cloud alert.
v5 was meant to be **driving**: finding setups itself from live exchange
data.

```
[ SCHEDULE: Cron 15 min ]
        ⬇
[ STEP 0: Bybit Universe ]   GET /v5/market/tickers → filter: turnover≥$10M,
        ⬇                    longs ≤62% → shortlist of 10–15 coins
[ STEP 1: Bybit Klines ]     200 1H bars per shortlist symbol
        ⬇
[ STEP 2: JS Risk-Engine ]   deterministic SMC: EQL, OB Low, VRVP POC,
        ⬇                    RSI, Stoch — from the same candles
[ STEP 3: v4.3 guards ]      spread, liquidity, OI impulse, geometry
        ⬇
[ STEP 4: Quantization ]     tickSize/qtyStep — same as v4.x
        ⬇
[ STEP 5: Execution ]        Telegram signal + link to the TV chart
                             (alert set manually in ~10 s)
```

## 1. "Stage zero" module: exchange pre-filter

Solves rate limits and wasted compute: instead of SMC analysis over 150+
tickers — a coarse filter on cheap endpoints.

- `GET /v5/market/tickers?category=linear` — one request for the whole
  universe.
- Primary filter (stricter than the v4.3 runtime guards — screening
  selects with margin): `turnover24h ≥ $20M`, exclude dated (`-DDMMMYY`)
  and denominated contracts, only TV tickers of form `BYBIT:*USDT.P`.
- `account-ratio` for survivors: longs ≥55% → not our setup (we want
  coins where the crowd is short/balanced — liquidity above).
- OI status: falling or flat OI over ~4h, no vertical pump — matching
  the v4.3 regime filter (don't step in front of the train).
- Result: 10–15 tickers enter the heavy klines+SMC cycle.

Bybit rate-limit budget (~600 req/5min/IP) fits with margin:
1 + 15 + 15×3 ≈ 50 requests per cycle.

## 2. Deterministic SMC detector (JS, instead of LuxAlgo)

| Construct | Algorithm from klines | Config parameter |
|---|---|---|
| **Equal Lows** | ≥2 local minima in a window, divergence ≤ tolerance | `eql_tolerance_pct` (0.05–0.3), `eql_window` |
| **Bullish OB** | last bearish candle before an impulse rally | `ob_impulse_pct`, `ob_window` |
| **VRVP POC** | volume profile: price bins, POC = max-volume bin | `vrvp_bins`, `vrvp_window` |
| **Squeeze score** | count of wicks that pierced a local low and closed above (squeezes/week) — priority in Telegram reports | `sqz_window` |

**Key argument for a custom detector:** its parameters are tuned in
Strategy Config and validated by historical backtest — LuxAlgo does not
allow that. We are not cloning LuxAlgo 1:1; we are building an
optimizable analogue.

## 3. Honest limit: auto-alerts on TV charts

TradingView has **no public API** for creating alerts or drawing on the
chart in retail plans (the official alerts API is for partner brokers
only). TV webhooks are strictly outbound; Pine cannot read external
HTTP → feeding data back into the chart is impossible.

A realistic, functionally-equivalent substitute:
- the Telegram signal carries a direct chart link:
  `https://www.tradingview.com/chart/?symbol=BYBIT:<SYMBOL>.P`
- one click → chart open → alert/line placed manually in ~10 s.

## 4. Open questions closed in this draft

- **Matching LuxAlgo:** not needed 1:1 — our detector is optimized via
  config and backtest. A v5-shadow mode stays as the cross-check tool.
- **AI role:** OpenRouter Free (~50 req/day) **banned at the screening
  stage** — only final audit for ALLOWED signals. All work is
  deterministic JS.
