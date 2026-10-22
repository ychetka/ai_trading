<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] System spec: SMC AI Analyst v4.4 — delta vs v4.3

> Retired. Deactivated 2026-10-23. Kept for history — see STRATEGY.md.

v4.4 added the ATR-volatility gate and hardened the deterministic engine.
A single 1H candle punching through POC, OB Low and stop in one bar was
the failure mode; the fix bounds the instrument's volatility.

## Additions over v4.3

- **ATR gate:** `atr_min_pct <= ATR% <= atr_max_pct`. ATR computed from
  the last 15 1H bars of `/v5/market/kline`
  (TR = max(high−low, |high−prevC|, |low−prevC|)); unavailable klines →
  block. Purpose: filter instruments whose hourly range can pierce the
  whole trap geometry in one bar.
- All other guards unchanged — see description_v4.3.md §3 and §4 for the
  full filter chain and the quantized order math.

## Output object (Trade Calc)

```json
{
  "blocked": false, "reason": "", "audit_fallback": "...",
  "ticker": "...", "price": 0, "btc": "...",
  "longs": "54.2", "shorts": "45.8",
  "ob_low": "...", "poc": "...", "rsi": "...", "stoch_k": "...",
  "limit": "82500.00", "stop": "81999.80", "qty": "0.199",
  "tp1": "83000.00", "tp2": "85490.00",
  "tick": "0.10", "qstep": "0.001",
  "risk": 100, "br_max": 62,
  "status_emoji": "🟢", "status_text": "ALLOWED"
}
```

On block: levels `FORBIDDEN` (or `N/A (Data error)`), `QTY 0`. The
message is assembled by the Telegram-node expression from Trade Calc
fields; user text is HTML-escaped, only `b,i,u,s,code,pre,blockquote`
allowed.
