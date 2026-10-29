<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# Trade AI Analyst

Autonomous, free-stack crypto analytics for Bybit USDT-margined
perpetual futures. Runs entirely on public market-data APIs — no paid
data feeds, no exchange keys, no real orders.

## What it is

A deterministic trend-following signal scanner plus a multi-venue
order-book telemetry service, wrapped in an n8n workflow engine. The
system is deliberately in **info mode**: it detects breakouts, tracks
them as virtual positions, measures outcomes, and reports — but never
touches real money until forward statistics prove positive expectancy.

## The strategy (v4.5.1)

Donchian breakout from a squeeze, long-only:

- Signal (1H close): `close > max(high,168)` Donchian upper band
- Volume gate: `vol > 1.5 × SMA20`
- Squeeze gate: channel bandwidth in bottom quintile (`bwP ≤ 0.2`)
- Entry model: next bar open + slippage `max(10bps, 3%×ATR)` + 5.5bps fee
- Exits: `ATR×2.5` initial stop, trailing `min(low,84)`, 960-bar expiry
- Universe: rolling top-10 perps by 30-day average turnover, re-ranked
  monthly; max 8 virtual slots; freshness gate rejects stale signals

Validated by portfolio backtest with full frictions and OOS split:
**+0.68R/trade, ~32% MaxDD, ~120 trades/year** on rolling top-10.
Six years of Bybit history, 112 symbols — see `STRATEGY.md` for the
full research arc, including the SMC mean-reversion branch that did not hold
(~37k signals → −0.16R/trade) and the cross-sectional-momentum
alternative track.

## Components

| Piece | Where | What |
|---|---|---|
| Donchian Scanner | n8n workflow | Hourly scan, virtual positions, Telegram digest |
| `tools/donchian_monitor.js` | CLI | Standalone mirror of the scanner core |
| Books Aggregator | n8n workflow | `GET /webhook/book?symbol=X` — order-book fan-out across 13 venues (CEX spot/perp + DEX perps: Bybit, Binance, OKX, Bitget, Gate, Kraken, Coinbase, MEXC, Hyperliquid, dYdX, Aster, Lighter) |
| Books UI | `GET /webhook/books-ui` | Standalone web dashboard: live depth, walls, imb history |
| History collector | n8n Schedule 15m | Snapshots → `books_history.jsonl`, 30-day rotation |
| Backtest stack | `tools/` | `backtest_donchian`, `backtest_portfolio`, `backtest_csmom`, `fetch_history` |
| Deploy scripts | `tools/deploy_*.js` | Patch n8n SQLite directly (workflows ship as code) |

## Layout

```
tools/             research + production code (scanner, backtests, deployers)
archive/           retired SMC-era code and docs (rejected, kept for history)
docker-static/     rootless Docker toolchain binaries + supervisor scripts
docker-data/       container state (gitignored — images, volumes, n8n DB)
docker-compose.yml n8n service (rootless, host-net, localhost-only)
data/klines/       research kline cache (gitignored, rebuildable)
```

## Rules baked into the project

- No real orders until backtest + forward test prove positive EV
- All math deterministic; LLM/AI only ever comments, never decides
- Everything informational: Telegram is a reporting channel only

## Status

Info-forward running since 2026-10-21. Collecting ~100-trade forward
sample before any go-live discussion. Hypotheses under active test:
Donchian edge reproduction, order-book wall ↔ failed-breakout
correlation (multi-venue snapshots at every entry).
