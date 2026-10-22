<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# System spec: v4.5.1
## "Donchian Info-Forward" — the trend pivot after SMC-MR falsification
### Delta vs v4.5 (see archive/docs/description_v4.5.md for the engine base)

Version: 4.5.1 (October 2026)
Status: deployed, info-mode. Real orders are FORBIDDEN.

## Strategic context

Deep validation (37k armed signals, 12 majors, 2021→2026, 6 years)
falsified the whole SMC mean-reversion family: the best cell
(bull+panic) = −0.01R/trade before fees. The edge turned out to be
clustered noise (N_eff≈6 episodes), not structure.

Validated replacement — **Donchian breakout + squeeze, long-only**:
full portfolio audit passed (frictions, slots, rolling universe,
OOS split). +0.68R/trade, DD 32%, ~120 trades/year on rolling top-10.
Details and matrices — STRATEGY.md.

## Current architecture (what actually runs in n8n)

```
┌─ SMC AI Analyst + SMC Screener — DEACTIVATED (active=0) ────────┐
│  Both workflows switched off 2026-10-23 after SMC-MR falsified. │
│  Snapshots: archive/workflows/, code: archive/tools/.           │
└──────────────────────────────────────────────────────────────────┘
┌─ Donchian Scanner (info) v4.5.1 — the ONLY active workflow ─────┐
│  Schedule hourly :02 + POST /webhook/donchian (manual run)       │
│    → Donchian Monitor (Code)                                     │
│      · daily turnover24h sample → state.tv (up to 30 values)     │
│      · top-10 re-rank on the 1st by 30d average turnover         │
│        (proxy of the backtest TVWIN; <7 samples → snapshot)      │
│      · signal on closed 1H: close>max(high,168),                 │
│        vol>1.5×SMA20, bwP≤0.2 (squeeze), long-only               │
│      · freshness gate: entry only if the signal bar closed       │
│        <90 min ago                                               │
│      · virtual positions: entry=open+slip+fee,                   │
│        trail=max(stop0,min(low,84)), expiry 960 bars, 8 slots    │
│      · multi-venue order-book snapshot at each entry             │
│      · state: /home/node/.n8n/donchian_state.json                │
│    → Telegram: ENTRY/EXIT/universe + Σstats                      │
│      + daily digest on the 00:0x UTC run (once a day):           │
│        24h trades/ΣR, open positions, 30d concentration,         │
│        avg holding, trail/expiry split, avg predicted slip       │
└──────────────────────────────────────────────────────────────────┘
┌─ Books Aggregator (svc) — internal microservice ────────────────┐
│  GET /webhook/book?symbol=X → 13-venue order-book fan-out        │
│  GET /webhook/book-history?symbol=X&hours=N → stored history     │
│  GET /webhook/books-ui → standalone web dashboard                │
│  Schedule 15min → snapshots to books_history.jsonl (30d kept)    │
└──────────────────────────────────────────────────────────────────┘

Trade record in state.trades: {sym, entry, exit, R, entryTs, exitTs,
bars (holding_bars), reason: TRAIL_HIT|EXPIRY, slipIn, slipOut, book}
— fields for forward metrics (slip drift, holding distribution,
exit mix, order-book wall correlation).
```

## Decommissioned (2026-10)

- The whole SMC branch: both workflows deactivated (active=0),
  `/webhook/tradingview` unregistered (404). Tools and snapshots —
  in archive/.
- TradingView alerts dismantled as a source.
- Inbound ingress: MikroTik NAT 80→8080, 8443→8443, 443→8444 removed;
  sslh/caddy/localtunnel stopped and disabled. All n8n webhooks are
  reachable on the LAN host only (0.0.0.0:5678 via port_fwd).
- "OpenRouter Key" unused by any active workflow.

## Forward protocol (criteria to leave info mode)

1. **Signal-path** (already collecting): live signals matching the model.
2. **Execution**: paper doesn't measure slippage — calibrating
   max(10bps,3%×ATR) needs a micro-live (~30 trades, 10 USDT risk) —
   a separate user decision.
3. **R distribution**: ~100 virtual trades (~7-8 months at current
   frequency) or statistical significance earlier.
4. **Fail-safe**: cumulative forward drawdown > ~1.5× the backtest
   MaxDD in R (~−95R) → hypothesis rejected.

## Tooling (tools/)

| File | Role |
|---|---|
| donchian_monitor.js | standalone Donchian scanner |
| deploy_donchian.js | SQLite workflow deploy; `--update` = new version |
| deploy_books.js | Books Aggregator (svc) workflow deploy |
| backtest_donchian.js | Donchian per-trade research |
| backtest_portfolio.js | portfolio sim: frictions, slots, rolling top-K |
| backtest_csmom.js | CS-Momentum equity sim + frictions + rolling top-K |
| fetch_history.js | Bybit klines loader → data/klines (112 syms) |
| screen_midterm_longs.js | mid-term long screener (support clusters) |
| archive/tools/* | SMC-era tools (eql/screener/sqz/backtest_*) — history |

## Live risks invisible in the backtest

- Correlation collapse: on BTC dumps alt correlation →1.0, slip on
  stops 15-25%×ATR instead of 3%.
- ADL on parabolic trends (Bybit deleverages winning positions).
- API latency on the hourly bar close (up to 1.5-3s) — softened by
  modelling the fill at next bar's open.
