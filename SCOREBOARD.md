# Strategy Scoreboard

Generated from `research/manifest.json` by `tools/scoreboard.js` - do not edit by hand.
Every number is a historical verdict with its N, horizon, regime and
friction assumptions attached. Past R is not a promise of future R.

## Scored strategies (ranked by meanR)

| # | Strategy | Family | Status | meanR | N | Win% | Horizon | Regime | Frictions | Evidence |
|---|----------|--------|--------|-------|---|------|---------|--------|-----------|----------|
| 1 | Donchian breakout from squeeze (v4.5.1) | trend | ACTIVE (forward) | +0.68R | backtest ~120 trades/yr | - | 1H signals, multi-day holds | mixed (6y Bybit history, 112 symbols) | full frictions: 5.5bps fee + max(10bps, 3%*ATR) slippage | workflow 66fb7895-f0b3-47 |
| 2 | Pump detector - ride variant | momentum | MARGINAL | +0.093R | 947 | 28% | post-pump forward | 6m, 8 symbols, mostly neutral | positive mean survives only via rare runners - dies on costs | issue #5 comment 2026-11-06 |
| 3 | SMC mean reversion (equal lows + OB/POC) | mean-reversion | REJECTED | -0.16R | ~37000 signals | - | intraday | mixed backtest | included | STRATEGY.md research arc |
| 4 | 5m z-score mean reversion | mean-reversion | REJECTED | -1.06R | 2593 | 16% | 5m bars | 6m window, 8 symbols | included | issue #9 / PR #11 |

## Not yet scored

| Strategy | Family | Status | Why / blocker | Ref |
|----------|--------|--------|---------------|-----|
| Persistent order-book walls as liquidity zones | order-book | NO EDGE | n=12390; -0.147; 49.5/50.5% on B-holds (coin flip) | issue #3 comment 2026-11-05 |
| Range/structure boundary touch (1H/4H) | mean-reversion | REJECTED | n=6633; -0.101; 52-53% (market drift baseline); 36-42% of touches break the boundary | issue #6 comment 2026-11-06 |
| Pump detector - fade variant | mean-reversion | UNTESTABLE | n=0; spot/perp divergence + OI filters produce zero qualifying samples over 6m - spec needs threshold relaxation decision | issue #5 comment 2026-11-06 |
| Volatility entry: walls + reconstructed liq map | order-book | ACCUMULATING | forward log live since 2026-11-07 (target n>50) | issue #47 / PR #50, #54 |
| BTC-dump relative-strength screener | cross-sectional | DATA-GATED | 98% of regime tags are neutral - no bear windows recorded yet | issue #8 |
| Paying-whale funding split as conviction signal | on-chain/whale | UNDERPOWERED | sample too small + all-neutral regimes | issue #22 |

## Reading this table

- **REJECTED** entries stay visible on purpose: the lab sells honest
  teardowns, and a documented failure is worth more than a cherry-picked win.
- **MARGINAL** means the mean is positive but the distribution does not
  survive costs - see median and win rate before believing the mean.
- **ACCUMULATING / DATA-GATED** entries are forward collectors; their
  first scored verdict requires n>50 or a non-neutral regime window.
