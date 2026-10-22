<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# Trade AI Analyst — strategy, hypotheses and status

This document records the project goal, architecture, and the validated
and falsified hypotheses.

## Mission

A fully autonomous, free AI analytics stack for crypto futures
(Bybit linear USDT-margined perps). The system is expected to earn
AI-server hardware and paid AI licenses. Hard rule: **real orders only
after statistics prove positive expectancy (EV)**.

## Current architecture (production, info mode)

```
Bybit V5 (1H klines, rolling top-10 liquid crypto perps by 30d turnover)
  └─ Donchian Monitor (n8n Code node, hourly :02 + manual webhook)
       ├─ signal: close > DC(168) high && vol > 1.5xSMA20 && bwP <= 0.2
       │    (long-only, freshness gate: signal bar < 90 min old)
       └─ virtual positions → Telegram digest (info-only, no orders)
```

- All strategy math is deterministic code — LLMs may only comment/audit.
- Books Aggregator (svc): internal microservice aggregating order books
  across 13 venues (CEX spot/perp + DEX perp) at each virtual entry —
  forward data for the order-book-wall hypothesis. Also collects
  15-min snapshots to JSONL and serves a standalone web UI.

## Backtest bench (tools/)

- `backtest_armed.js` (archived): SMC armed/sweep/reclaim modes,
  top-50 crypto perps, 500–1000 1H bars, 96-bar forward sim,
  conservative intrabar (stop before target), no fees.
- `backtest_deep.js` (archived): deep-history variant, 2021→2026.
- `backtest_csmom.js`: cross-sectional momentum equity sim.
- `backtest_donchian.js` + `backtest_portfolio.js`: per-trade and
  portfolio simulators for the Donchian strategy.
- `donchian_monitor.js`: standalone mirror of the live n8n Code node.
- `screen_midterm_longs.js`: manual mid-term long screener.
- `fetch_history.js`: Bybit klines → `data/klines` disk cache.

## Audit results — SMC epoch (falsified)

| Config | dec | WR | R | R/trade |
|---|---|---|---|---|
| armed LONG | 716 | 41% | −68.2 | −0.10 |
| sweep LONG | 393 | 24% | −82.8 | −0.21 |
| reclaim LONG | 177 | 7% | −81.8 | −0.46 |
| sweep2 LONG | 76 | 20% | −29.5 | −0.39 |
| armed SHORT | 0 signals | — | — | — |
| sweep SHORT | 272 | 22% | −106.0 | −0.39 |
| **armed LONG + BTC Δ24h < −2%** | 44 | 39% | **+30.1** | **+0.68** |
| — of which: symbol Δ24h < −3% | 18 | 39% | +34.4 | +1.9 |

Key facts:
- The trap fills ~88% of the time — the problem is not price delivery
  but that the pool is more often a transit stop than a reversal
  (62% of stops occur before POC).
- Retest of a swept level is the worst entry (7% WR): the stop below
  the sweep low is taken on the second pass.
- Multi-sweep (entry on second poke) confirms breakout, not reversal.
- EQH shorts: +21.5R on the last 500 bars turned out to be −106R on
  1000 — window luck, not edge.

## Working hypothesis v5.0 (later falsified)

**"armed-long = buying the end of panic".** The same trap (EQL pool
below POC, limit at mid(POC,OB)) becomes positive only during acute
panic: BTC Δ24h < −2% → +0.68R/trade; if the symbol itself dumps >−3%
→ +1.9R/trade. In calm markets the same signal carries −102R over
666 trades.

Open questions at the time: best operational panic proxy (BTC Δ24h,
OI cascade, funding, volume spike, liquidation clusters); the 44 trades
clustered in time — effective sample smaller; fee role (~0.1R);
whether a symmetric short mode exists.

## Deep-history validation (2021-01 → 2026-10, 12 majors, backtest_deep.js)

**Hypothesis v5.1 "armed-long = buying panic in bull regime" — FALSIFIED.**

36,924 armed signals, ~6 years: total **−5801.5R**, −0.16R/trade, WR 41%.

| Regime × panic | dec | WR | R | R/trade |
|---|---|---|---|---|
| bull/panic | 1057 | 46% | −5.5 | −0.01 |
| bull/extreme (Z≤−3.5) | 5 | 0% | −5.0 | −1.00 |
| bear/panic | 1579 | 40% | −226.2 | −0.14 |
| bear/extreme | 15 | 0% | −15.0 | −1.00 |
| bull/calm | 17672 | 39% | −3153.5 | −0.18 |
| bear/calm | 14297 | 41% | −2213.1 | −0.15 |

- The `bull+panic` cell over 6 years = **breakeven before fees** (−0.01R).
  The +39.6R from the 1000-bar window was noise/overfit.
- Episode clustering: 394 panic episodes, Σtop3R = **−136R**.
- Benchmarks: May-2021 +6.4R, SVB +10.5R, Black Monday +3.9R; LUNA −5,
  FTX −10.1, Matrixport −22.3, Iran-Apr-2024 −37.1. No systematic edge.
- Panic does lift expectancy (−0.01R vs −0.15..−0.18R) — the regime
  discriminates for real, but **not enough**: the geometry lacks the
  asymmetry to break zero after costs.
- Bottom line: mean-reversion to POC off EQL pools on 1H is not an edge
  on Bybit in any tested regime or geometry (armed/sweep/reclaim/sweep2
  × filters × 6 years).

## Hypothesis v6.0: Cross-Sectional Momentum (backtest_csmom.js)

After SMC falsification the logic was inverted: don't catch reversals,
exploit autocorrelation of relative strength (retail buys the dip and
shorts the rip — do the opposite).

Signal: `score_i = ROC_i(L)/σ_i(1h-rets)`, long top-K, short bottom-K,
rebalance every F hours, BTC<EMA200 → shorts only, taker 0.055%/side.

Results (12 majors, 2021→2026, equity curve):
- Gradient confirms a real effect: short lookbacks (24–72h) are eaten by
  fees; edge grows monotonically to L=336h (2 weeks), then decays.
- **Peak: L=336 / F=168 (weekly rebalance), K=3:**
  - L/S: +199.5%, Sharpe 0.72, MaxDD 39.9%, fees 13.8%
  - long-only: +180.1%, Sharpe 0.82, MaxDD 33.0%, fees 5.4%
  - BTC buy&hold: +184.2% (with ~75%+ historical DD)
- By year L/S: 2021 −15%, 2022 +91%, 2023 −12%, 2024 +57%, 2025 +29%
- By year long-only: 2021 +20%, 2022 −7%, 2023 +41%, 2024 +86%, 2025 −10%
- 4/6 positive years for both variants — the first durably positive
  strategy in project history.

Caveats: survivorship (universe = surviving majors), narrow cross-section
(12 symbols), no slippage model, equity sim rather than per-trade R.

### Friction audit (v4.5.1): --nextopen + slip max(10bps,3%×ATR) + fee

Same fill model as backtest_portfolio.js: fill at open[t+1], drag on
both legs, fee inside fill price.

| Config | Ret% | Sharpe | MaxDD | drag |
|---|---|---|---|---|
| 112 sym, K=5 L/S, zero costs | +329.0 | 0.83 | 29.8% | — |
| **112 sym, K=5 L/S, full frictions** | **+155.4** | **0.60** | **36.4%** | 51.9% |
| 112 sym, K=5 long-only, frictions | +106.2 | 0.54 | 41.1% | 19.1% |
| rolling top-20, K=5 L/S | +65.1 | 0.42 | 31.7% | 40.2% |
| rolling top-30, K=5 L/S | +30.0 | 0.30 | 49.8% | 44.4% |

- Edge SURVIVES frictions: +329% → +155%, Sharpe 0.83 → 0.60.
- **Inverse gradient vs Donchian**: CS-Momentum is WORSE on the liquid
  top — its alpha ∝ cross-sectional dispersion, and the top-20 moves
  like one asset (beta). Full 112-symbol universe is the right domain.

## Hypothesis v6.1: Donchian breakout + squeeze (backtest_donchian.js,
##    portfolio simulator backtest_portfolio.js)

Per-trade research (no costs): N=168/exit84/ATR2.5, 112 symbols:
16,338 trades, +3290R, +0.20R/trade, 24% WR; positive every year;
88/112 symbols positive. Parameter plateau, not a point peak.

Portfolio simulator (backtest_portfolio.js): fill at next bar's open,
fees, dynamic slip max(10bps, 3%×ATR/close), slot cap, risk sizing,
trail/stop/expiry 960 bars. Edge-loss decomposition:

- zero friction, no cap: +0.087R/trade (vs +0.20R naive — ~0.11R goes
  to next-bar/exits/expiry mechanics)
- +fees and slip on 112 symbols: +0.004R/trade ≈ zero; capped at
  8 slots with 0.75% risk → −0.071R, equity −97% (variance drag at 22% WR)
- **narrow liquid universe (15 majors), long-only, slots=8:**
  +0.403R/trade, equity 9.33x, MaxDD 48.5%, positive 5/6 years
- shorts: −0.078R/trade — short side is net negative (crypto long bias)
- **OOS 2024→2026 (N=168, long, same params): +0.438R/trade,
  3.24x, DD 48.5% — edge confirmed on the independent half of history**
- N-robustness: 120 → +0.31R, 168 → +0.40R, 240 → +0.34R — plateau.

## Rolling universe (v4.5.1): monthly top-K re-rank by 30d turnover

`backtest_portfolio.js --topk=K` (no --syms): on the first bar of each
month the universe = top-K of all 112 cached perps by Σ(v×c, 720 bars).
Positions on dropped symbols run to exit; new entries blocked.

| Universe | R/trade | equity | MaxDD |
|---|---|---|---|
| static 15 majors | +0.403 | 9.3x | 48.5% |
| rolling top-20 | +0.375 | 11.8x | 50.9% |
| rolling top-15 | +0.493 | 18.4x | 40.9% |
| **rolling top-10** | **+0.680** | **18.8x** | **31.9%** |
| rolling top-5 | +0.633 | 4.6x | 23.4% |

- OOS 2024→2026 (rolling top-20): +0.553R/trade, 6.0x, DD 42.7%.
- Monotone gradient: deeper liquidity, better results. Optimum top-10.
- Survivorship not fully removed: cache = only currently-traded perps
  (LUNA/FTT unavailable). But turnover-based rotation is itself the
  production design, closer to reality than a static list.
- Long-only config: Donchian N=168/ATR2.5/squeeze≤0.2/vol>1.5×SMA20,
  rolling top-10 by 30d turnover, 8 slots, 0.75% risk →
  ~+0.68R/trade, DD 32%. Working config for the info-forward.

## Liquidity-layer research (2026-10-22, archived tests)

Order-book / liquidity-map hypothesis series — closed:

- "Long a dense liquidity layer, TP at the opposite layer" (ladder or
  per-layer stop): dead on the real Oct-2026 path — cascades eat
  consecutive layers (−2.8…−3.0% on the episode).
- "Dense zone = magnet (price will come)": falsified on 6.7M levels —
  dense clusters get touched LESS than single levels at equal distance;
  distance dominates, density confounded by proximity.
- "Dense zone = fuel for movement already aimed at it": a weak real
  effect (+1–2 p.p. over momentum alone) — below the friction threshold
  for a standalone strategy; already encoded in Donchian (breakout into
  the stop-density zone rides the cascade).

## Info-forward deployed (2026-10-21): "Donchian Scanner (info)" workflow

- n8n workflow: Schedule hourly :02 + webhook `/webhook/donchian`
  (manual test) → Code node (port of tools/donchian_monitor.js) →
  Telegram digest. Empty output = silence.
- Virtual positions and stats in `/home/node/.n8n/donchian_state.json`
  (volume, survives restarts).
- Universe re-ranks on the 1st by the 30d average turnover24h (daily
  samples in state.tv; <7 samples → snapshot). Proxy of the backtest
  Σ(v×c,720).
- Freshness gate: entry only if the signal bar closed <90 min ago —
  blocks stale-signal entries after downtime.
- Events: universe re-rank, ENTRY (entry/stop/score/slot + order-book
  snapshot line), EXIT (R, TRAIL_HIT/EXPIRY, duration), watch events for
  breakouts killed by gates, pipeline stage counters, daily digest at
  the 00:0x UTC run (24h trades/ΣR, open positions, 30d entry
  concentration, avg holding, exit-reason split, avg predicted slip).
- Trade record: {sym, entry, exit, R, entryTs, exitTs, bars,
  reason, slipIn, slipOut, book} — forward metrics for slip-drift,
  holding time, and the order-book wall hypothesis.
- Standalone: `node tools/donchian_monitor.js --verbose`.
- Deploy: tools/deploy_donchian.js (SQLite inject per NOTE 4;
  `--update` patches the existing workflow with a new version).

## Codebase audit for v4.5.1 (2026-10-23)

- SMC branch deactivated: both workflows active=0, `/webhook/tradingview`
  unregistered (404). Hypothesis falsified — code and snapshots moved
  to archive/ (tools, workflows, pre-v4.5 docs).
- Fixed in the live Donchian loop:
  · universe proxy aligned with the backtest — re-rank by 30d average
    turnover24h instead of a one-off snapshot;
  · freshness gate 90 min on the signal bar.
- OpenRouter credentials unused by active workflows (audit comments were
  on the SMC path). Telegram credentials in use.
- Ingress stack (NAT/sslh/caddy/localtunnel) decommissioned, files kept.

## Development rules

- No real orders until EV is proven (backtest + forward test).
- Telegram is an info channel; monitor and engine run in info mode.
- Determinism > LLM: all math in code, AI only audits/comments.
- Short, substantive commits; production workflow snapshots in git.
- Versioning: git tag `v4.5` = baseline (SMC monitor v4.5 + research
  stack). All subsequent system changes = the v4.5.1 line (rolling
  universe, Donchian scanner, forward protocol).
