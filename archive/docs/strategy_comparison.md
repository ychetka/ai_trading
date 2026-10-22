<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] Comparative analysis of top quant strategies (honest edit)

Version: 2026-10-06. No marketing numbers — estimates from real mechanics.

| Strategy | Mathematical essence | Win rate (realistic) | R:R / yield | Backend complexity | Main hidden risk |
|---|---|---|---|---|---|
| **1. Ours (then): Mean Reversion & Liquidity Sweeps** | Catching retail squeeze wicks in liquidity pools with reversion to POC | ~55–65% (65–75% upper bound on a perfect market) | TP1 ≈ 1:1, TP2 ≈ 1:11 (on BTC at tp2=+3%) | High — closed in v4.x (quantization, guards, book filters) | SMC detection quality: dependence on TradingView plots |
| **2. Funding Rate Arbitrage (delta-neutral)** | Spot long + futures short, collecting funding every 8h | NOT 100%: funding flips negative | ~10–25% APR, rare painful drawdowns | Medium (needs API keys, spot + futures balances) | Liquidation of the futures leg on a pump + fees |
| **3. Trend Following (momentum)** | Channel breakouts on OI surges | ~35–45% | up to 1:15 on pumps | Low | Antagonist of our strategy — useful as a **regime filter** |
| **4. Spread arbitrage (statistical)** | Pairs trading on cointegrated assets | ~80% (until the first correlation break) | 1:1–1:2, frequent takes | Ultra-high (cointegration matrices on the server) | Correlation collapse in stress — both legs red |

## Architectural conclusions

1. **Our niche confirmed (at the time):** high R:R from entry precision,
   not trade frequency. Main risk was not order math (closed in
   v4.1–v4.3) but the SMC data source. — NOTE: this conclusion was
   later overturned; deep-history backtests falsified the SMC family
   (see STRATEGY.md). Trend-following — the "antagonist" in this table —
   became the production strategy.
2. **Trend Following is not a competitor but a safety:** strong trend +
   rising OI = market maker pierces the stop pool, the trap must stay
   silent. Implemented in v4.3 as the `oi_chg > X% AND btc_1h < −Y%`
   guard.
3. **Funding arb and stat arb are separate products**, not an evolution
   of this pipeline. They require private API keys and spot balances.
