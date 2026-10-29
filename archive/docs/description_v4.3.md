<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] System spec: SMC AI Analyst v4.3
## "Sniper AI Risk Radar" — Mean Reversion & Liquidity Sweeps
### Deterministic risk engine + AI commentator

> Retired. Deactivated 2026-10-23 after deep-history backtests rejected
> the SMC mean-reversion family. Kept for history — see STRATEGY.md.

Doc version: 4.3 (October 2026)
Status at the time: deployed, verified end-to-end (executions #16–#31).
v4.1 changes: exchange price/QTY quantization by Bybit metadata
(`instruments-info`), degenerate-geometry guards, `sl_offset` → `sl_ticks`.
v4.2 changes: `Bybit Ticker` node (`/v5/market/tickers`), liquidity guards
(`turnover24h`), abnormal-spread guard (in ticks), stale-alert guard
(`|lastPrice−price|`), symbol regex guard (USDT perpetuals only).
v4.3 changes: `Bybit OI` node (`/v5/market/open-interest`) and `Bybit BTC`
(`/v5/market/tickers?symbol=BTCUSDT`), trend-dump regime filter — the trap
does not stand against impulse with rising OI.

---

## 1. Concept and strategy

Counter-trend scalping and liquidity hunting. The strategy hunted zones
where retail hides stops (Equal Lows + liquidation pool between VRVP POC
and OB Low). Thesis: a market maker sweeps stops with a squeeze → instant
reversion to POC. A limit "trap" sits in the middle of the pool.

Market entry always forbidden — LONG LIMIT only.

### Trap logic

```
price > POC  →  squeeze down through the stop pool (POC … OB Low)
            →  LONG LIMIT at pool midpoint
            →  STOP below OB Low
            →  TP1 at POC (return to mean volume, move to BE)
            →  TP2 above POC (structure target)
```

## 2. Pipeline architecture

```
TradingView (alert on Equal Lows / SMC, TF 1H)
   │  POST JSON → HTTPS webhook
   ▼
n8n workflow "SMC AI Analyst"
   ├─ Webhook from TradingView   POST /webhook/tradingview
   ├─ Strategy Config            Set node: all strategy thresholds
   ├─ Bybit Sentiment            GET api.bybit.com/v5/market/account-ratio
   ├─ Bybit Instrument           GET api.bybit.com/v5/market/instruments-info
   ├─ Bybit Ticker               GET api.bybit.com/v5/market/tickers
   ├─ Bybit OI                   GET api.bybit.com/v5/market/open-interest
   ├─ Bybit BTC                  GET tickers?symbol=BTCUSDT (BTC 1h trend)
   ├─ Trade Calc                 Code node: ALL math and filters (JS)
   ├─ OpenRouter Free AI         audit-only 1-sentence comment
   └─ Send to Telegram           sendMessage, HTML
```

## 3. Guards inside Trade Calc (all deterministic JS)

- Input validation: any NaN/undefined metric → 🔴 FORBIDDEN, QTY=0.
- Geometry: `ob_low < poc`, `price > poc`, `limit > stop` — else block
  ("degenerate geometry").
- Liquidity: `turnover24h >= min_turnover24h` (else thin book).
- Spread: `(ask1−bid1)/tickSize <= max_spread_ticks`.
- Stale alert: `|lastPrice−price|/price <= price_dev_max_pct`.
- Symbol: `^[A-Z0-9]+$` after stripping `.P` (blocks dated futures).
- ATR gate: `atr_min_pct <= ATR% <= atr_max_pct` (ATR(14) from last 15
  1H bars via `/v5/market/kline`; missing klines → block).
- Sentiment: `buyRatio×100 > buy_ratio_max` → 🔴 (long overload).
- Overheat: `(rsi > rsi_max OR stoch_k > stoch_max) AND btc >
  btc_heat_max` → 🔴.
- Trend gate (v4.3): `oi_chg > oi_rise_max_pct AND btc_1h <
  −btc_dump_max_pct` → 🔴 "trend dump — do not stand against momentum".

## 4. Order math with exchange quantization (v4.1)

```
LONG LIMIT = floor((volume_poc + ob_low) / 2,      tickSize)
STOP LOSS  = floor(ob_low − sl_ticks × tickSize,   tickSize)
TP1        = floor(volume_poc,                      tickSize)
TP2        = floor(volume_poc × (1 + tp2_pct/100),  tickSize)
QTY        = floor(risk_usdt / (LIMIT − STOP),      qtyStep)
```

All prices floored to the nearest valid tick; output decimals taken from
tickSize/qtyStep strings. Post-quantization checks: `limit > stop`,
`qty >= minOrderQty`, `qty <= maxOrderQty` — violation → block.

## 5. AI commentator (OpenRouter)

- Role narrowed to audit: receives the finished verdict + context and
  writes ONE sentence (≤25 words) of Mean Reversion interpretation — no
  numbers, no markdown, no HTML.
- Fallback chain: `nvidia/nemotron-3-ultra-550b-a55b:free` →
  `qwen/qwen3.8-27b:free` → `google/gemma-4-31b-it:free`. Retry ×4 @15s.
- `onError=continueRegularOutput`: an OpenRouter failure/limit does not
  break the chain — Telegram gets `audit_fallback` from Trade Calc.

## 6. Live test results

| # | Scenario | Outcome |
|---|---|---|
| #16 | Empty `volume_poc`, no `rsi` | 🔴 data error, QTY=0 |
| #17/#22/#26 | DOTUSDT.P, buyRatio 74.8–75.2% | 🔴 long overload |
| #21 | BTCUSDT.P, buyRatio 54.0% | 🟢 LIMIT 82500 / SL 81999.999 / QTY 0.19 |
| #23 | End-to-end POST via public HTTPS | ✅ full cycle to Telegram |
| #25 | BTCUSDT.P v4.1, longs 55.1% | 🟢 LIMIT 82500.00 / SL 81999.80 / QTY 0.199 / TP1 83000.00 / TP2 85490.00 |
| #27 | `ob_low > poc` (degenerate) | 🔴 "geometry broken", QTY=0 |
| #28 | BTCUSDT.P v4.2, longs 55.2% | 🟢 LIMIT 85250.00 / SL 84999.80 / QTY 0.399 (turnover $4B, spread 1 tick) |
| #29 | XRPUSDT-30OCT26 | 🔴 $8/24h turnover + 47-tick spread — double block |
| #30 | XRPUSDT-30OCT26 after regex guard | 🔴 "unsupported instrument" |
| harness | 1000PEPEUSDT (qtyStep=100) | 🟢 QTY 8333300 — correct quantization on a denominated token |
| #31 | BTCUSDT.P v4.3 | 🟢 full cycle, OI filter transparent |
| harness | OI +5% + BTC −0.99%/1h | 🔴 "trend dump — not standing in front of the train" |
| harness | OI +5%, BTC flat | 🟢 pass — surge without dump ≠ cascade |

## 7. Known limits and risks

- **SMC data source:** OB/POC/oscillator values depended on what the
  TradingView alert actually exported; LuxAlgo SMC draws OB/EQL as boxes,
  not plots → custom Pine export was needed for stable numbers (v4.5
  later removed this dependency entirely).
- **Latency:** free models answer in 5–60 s; on timeout a fallback goes
  out — does not affect the signal.
- **LONG trap only.** SHORT mirror not implemented.
- **Liquidation zone** modelled narratively (POC↔OB), not from book/OI.

## 8. Roadmap (as of v4.3)

- SHORT mirror: short overload → squeeze up off POC.
- Pine "Radar Export": one indicator publishing all needed plots
  (OB Low, POC, RSI, Stoch K, BTC close via request.security).
- Bybit API scanner over many tickers (backlog; keep SMC concept).
- Auto-execution on Bybit — only after instrument-aware math.
