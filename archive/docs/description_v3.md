<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] System spec: SMC AI Analyst v3
## "Sniper AI Risk Radar" — Mean Reversion & Liquidity Sweeps

> Retired. Deactivated 2026-10-23 after deep-history backtests rejected
> the SMC mean-reversion family. Kept for history — see STRATEGY.md.

Doc version: 3.0 (October 2026)
Status at the time: deployed, active, verified end-to-end (executions #13–#20).

---

## 1. Concept and strategy

Counter-trend scalping and liquidity hunting. The market spends ~80% of
its time ranging or distributing. The strategy looked for extreme
deviations and zones where retail hides stops (Equal Lows + a pool under
VRVP POC). The thesis: a market maker sweeps those stops with a squeeze
→ instant mean reversion to POC. The system placed a limit "trap" inside
the liquidation pool to catch the squeeze wick.

Market entry always forbidden — LONG LIMIT only, inside the stop-hunt zone.

## 2. Architecture

```
TradingView (alert on Equal Lows, TF 1H)
   │  POST JSON → HTTPS
   ▼
localtunnel  https://<your-subdomain>.loca.lt
   │  → host :5678 → port_fwd.py → inner netns
   ▼
n8n workflow "SMC AI Analyst" (rootless Docker, Debian 13)
   ├─ Webhook from TradingView   POST /webhook/tradingview
   ├─ Strategy Config            (Set node: all tunable thresholds)
   ├─ Bybit Sentiment            (HTTP GET api.bybit.com/v5/market/account-ratio)
   ├─ OpenRouter Free AI         (HTTP POST /api/v1/chat/completions, fallback models)
   └─ Send to Telegram           (sendMessage, HTML)
```

### Host and infrastructure

- Debian 13, no root → rootless stack: `unshare` (single-uid userns) +
  own netns + `slirp4netns` (outbound NAT) + `port_fwd.py` (inbound :5678).
- Docker 29.8.1 (static binaries), `n8n-local:latest` image built manually
  (`fetch_image.py`: registry layers → flatten rootfs uid/gid=0 → docker import).
- Autostart: systemd user services `rootless-docker.service` +
  `localtunnel.service`, linger enabled. Container `n8n-crypto-bot`,
  `restart: always`, volume `crypto-analyst_n8n_storage` (DB, workflows, creds).
- Free OpenRouter models (fallback):
  `nvidia/nemotron-3-ultra-550b-a55b:free` → `qwen/qwen3.8-27b:free` →
  `google/gemma-4-31b-it:free`. Retry ×4 at 15 s. Key limit ~50 free
  requests/day.
- All components free; the only paid part was the TradingView
  subscription (needed for webhooks).

## 3. Incoming payload (TradingView alert message)

```json
{
  "ticker": "{{ticker}}",
  "price": "{{close}}",
  "ob_low": "{{plot(\"OB Low\")}}",
  "volume_poc": "{{plot(\"Volume POC\")}}",
  "rsi": "{{plot(\"RSI\")}}",
  "stoch_k": "{{plot(\"K\")}}",
  "btc_price": "{{ticker(\"BYBIT:BTCUSDT.P\", \"close\")}}"
}
```

Known TradingView limits:
- `{{plot("name")}}` resolves only for the indicator the alert is on,
  and only for `plot()` outputs (LuxAlgo SMC boxes/lines are not plots).
- `{{ticker("SYMBOL","close")}}` — no such placeholder; cross-symbol
  data only via Pine `request.security()` + plot.
- Inner quotes must be escaped `\"` or the JSON breaks.
- Positional `{{plot_0}}..{{plot_4}}` is an alternative to names.

## 4. Enrichment: Bybit Sentiment

The `Bybit Sentiment` node performs:

```
GET https://api.bybit.com/v5/market/account-ratio
    ?category=linear
    &symbol=<ticker minus ".P" suffix>
    &period=5min
    &limit=1
```

Returns `result.list[0].buyRatio` (long share, 0..1) and `sellRatio`.
Passed to the prompt as a percentage (buyRatio×100). Public endpoint, no
key. Retry ×3, 10 s timeout.

NOTE: the node reads the ticker via
`$('Webhook from TradingView').item.json.body.ticker` — its `$json`
points at the Strategy Config output, not the webhook body.

## 5. Strategy Config — tunable parameters

A Set node at the start of the chain; edited in the UI without touching
the prompt:

| Parameter | Default | Purpose |
|---|---|---|
| `risk_usdt` | 100 | Per-trade risk, USDT (QTY + header) |
| `buy_ratio_max` | 62 | Long-overload threshold, % |
| `btc_heat_max` | 84000 | BTC overheat threshold |
| `rsi_max` | 70 | RSI overheat threshold |
| `stoch_max` | 80 | Stoch %K overheat threshold |
| `tp2_pct` | 3 | TP2 = POC × (1 + tp2_pct/100) |
| `sl_offset` | 0.001 | Stop offset below OB Low |

Changes apply after Save + workflow reactivation.

## 6. Hard AI rules (OpenRouter prompt)

Priority top to bottom:

0. **Data validation.** Any numeric variable (`price`, `ob_low`,
   `volume_poc`, `rsi`, `stoch_k`, `buy_ratio`) = undefined/empty/null/NaN
   → immediate stop: 🔴 FORBIDDEN, `QTY = 0`, parameters
   `N/A (Data error)`.
1. **Sentiment filter.** `buy_ratio > buy_ratio_max` → 🔴 FORBIDDEN
   (Long overload), `QTY = 0`, audit: "Crowd overloaded long. High risk
   of a deep dump beyond the OB. Trap cancelled."
2. **Overheat filter.** `RSI > rsi_max` or `Stoch K > stoch_max` =
   overheat; if also `BTC > btc_heat_max` → 🔴 FORBIDDEN.
3. **Squeeze math** (institutional sizing):

   ```
   LONG LIMIT = (volume_poc + ob_low) / 2     # middle of liquidation pool
   STOP LOSS  = ob_low - sl_offset          # behind the order block
   TP1        = volume_poc                  # Mean Reversion + move to BE
   TP2        = volume_poc * (1+tp2_pct/100)
   QTY        = risk_usdt / (LIMIT - STOP)  # rounded down
   ```
4. Limit trap only. Filters passed → 🟢 ALLOWED, trap placed.

## 7. Output format (Telegram, HTML ~10 lines)

```
<b>[🔴/🟢] MARKET ENTRY [FORBIDDEN/ALLOWED]</b>
<b>• Market scan:</b> TICKER | <b>BTC:</b> BTC_PRICE
<b>• Bybit sentiment:</b> Longs = X% | Shorts = Y% [normal / overload]
<b>• Metrics:</b> OB Low=… | VRVP POC=…
<b>• Mean Reversion audit:</b> [1 sentence]

<b>🎯 BYBIT SNIPER TRAP v3 (Risk 100 USDT):</b>
<code>🟢 LONG LIMIT: …
🛑 STOP LOSS: …
📦 QTY: … contracts

🎯 TP1 (Mean Reversion): … (move to BE)
🎯 TP2 (Structure): …</code>
```

Telegram node: parse_mode HTML, `appendAttribution=false`, text
expression escapes all HTML and keeps only safe tags
(`b,i,u,s,code,pre,blockquote`); unclosed tags dropped → Telegram API
400 errors ruled out.

## 8. Live test results

| # | Scenario | Outcome |
|---|---|---|
| #13 | Real TV alert (broken JSON, unescaped quotes) | Graceful degradation: 🔴, QTY=0 |
| #16 | Empty `volume_poc`, no `rsi` | 🔴 Data error, QTY=0 |
| #17 | DOTUSDT.P, real buyRatio 74.9% | 🔴 Long overload, trap cancelled |
| #18 | BTCUSDT.P, buyRatio 54.2% | 🟢 LIMIT 82500 / SL 81999.999 / QTY 0.19 / TP1 83000 / TP2 85490 |
| #20 | Same after adding Strategy Config | 🟢 identical calc, parameters from config |

## 9. Known limits and risks

- **Latency:** free models answer in 30–120 s (up to 4 min with retries)
  — fine for a 1H trap, not for M1 scalping.
- **LLM arithmetic** — not a deterministic calculation; exact numbers
  should be double-checked before placing an order.
- **Liquidation zone** modelled narratively, not from order book/OI.
- **localtunnel:** free tier — occasional Bad Gateway; subdomain can be
  lost on service restart (re-request ~60 s).
- **OpenRouter limit:** ~50 free requests/day per key.
- **SHORT direction** not implemented in spec v3 (LONG trap only).
- Fixed: systemd ordering cycle `localtunnel↔rootless-docker` broke
  tunnel autostart after reboot (After=default.target →
  network-online.target).

## 10. Roadmap (as of v3)

- SHORT mirror (short overload → squeeze up off POC).
- Bybit API scanner: 1H schedule → tickers → klines → deterministic
  SMC/VRVP/RSI/Stoch in a Code node → LLM for the shortlist only
  (bypasses the 50 req/day limit, removes TradingView/localtunnel).
- Replace localtunnel with Cloudflare Tunnel (needs own domain).
- Auto-execution on Bybit (API keys, secret management) — only after
  deterministic math and audit.
