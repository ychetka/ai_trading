<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] Realistic concept: Sniper AI Risk Radar (SMC + VRVP Adaptive Analyst)

> Retired pre-v3 concept document, kept for history. The SMC family of
> hypotheses was later falsified by deep-history backtests — see
> STRATEGY.md. Original era: TradingView alerts → n8n → LLM → Telegram.

A hybrid algo-trading complex combining leading TradingView indicators
with analytical text modelling by free LLMs (OpenRouter fallback) to
filter trade signals and enforce strict risk control.

Optimized for the **1H** timeframe; designed for manual limit-order
placement based on composite verdicts sent to Telegram.

---

## System architecture

### 1. Data supply layer (TradingView Cloud — 1H)

The system works on the hourly timeframe, which neutralizes signal
delivery latency. A balanced metric pack is sent to n8n:

* **Smart Money Concepts (SMC):** zones of strength (Order Blocks) and
  retail liquidity pools (Equal Lows).
* **Volume Profile (VRVP):** Point of Control (POC) — the max horizontal
  whale-volume level.
* **Oscillators:** live RSI and Stochastic RSI %K for overheat assessment.

### 2. Infrastructure bridge (Rootless Docker + n8n + Debian 13)

Fault-tolerant backend in an isolated user namespace without root.
`localtunnel` provided the stable HTTPS channel for webhooks. The
Telegram node used smart HTML sanitization, protecting against 400 Bad
Request parse errors from AI special characters.

### 3. Neural audit layer (OpenRouter Free Fallback)

The workflow cascades free LLM models (Nemotron / Qwen / Gemma)
depending on availability.

* **BTC leader filter:** logical ban on market entry while BTC is in
  extreme rally or price discovery (>80k).
* **Liquidation narrative:** the AI did not compute real stop clusters
  (no order book/funding access); it formed a logical description of
  retail panic zones from the mutual arrangement of price, POC and
  OB Low.
* **Position sizing:** exact contract count for Bybit under fixed risk
  (**100 USDT**): `Qty = 100 / (Entry - Stop)`.

---

## Technical limits and notes (QA)

* **Processing speed:** due to free-tier load on OpenRouter and auto-
  retries on 429s, real verdict latency was **15 s to 3–4 min**. For
  positional intraday on 1H this was valid and safe.
* **Placeholder dependency:** the system required strict control of the
  incoming JSON syntax to prevent text strings reaching AI math formulas.
