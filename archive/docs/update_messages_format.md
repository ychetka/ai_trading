<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] Task: compact the AI analyst's Telegram message format

> Historical task spec for updating the `OpenRouter Free AI` node's
> `jsonBody`. The workflow is retired; kept for history.

Goal: drastically compress the final AI answer for Telegram, remove
spam, keep a dense technical audit of all key indicators.

## Actions (as specified)

1. Open the `OpenRouter Free AI` node configuration.
2. Replace the `jsonBody` field with the structure below.
3. Force-save the workflow and verify the `Active` toggle stays on.

The new `jsonBody` set `model: meta-llama/llama-3-8b-instruct:free` with
a single user message whose content was (translated):

```
You are a professional risk manager of the crypto futures market.
Produce an ultra-compact sniper verdict from the incoming data — no
greetings, no disclaimers. ≤8–10 lines.

Incoming data:
- Asset: {{ $json.body.ticker }}
- Current price: {{ $json.body.price }}
- Order Block bound (OB Low): {{ $json.body.ob_low }}
- Volume POC: {{ $json.body.volume_poc }}
- Leader (BTC/USDT): {{ $json.body.btc_price }}

HARD VERDICT RULES:
1. Format strictly fixed, dry, copy-ready.
2. In the INDICATORS block briefly state: where price is relative to POC
   (Volume Profile), whether the Order Block (SMC) is confirmed, and
   model Liquidation Levels risk.
3. Risk always 100 USDT. Qty = 100 / (Entry - Stop).
4. If BTC overheated (>80k) → hard FORBIDDEN on market entry.

OUTPUT STRICTLY THIS TEMPLATE (HTML tags for Telegram):

<b>[🟢/🔴] MARKET ENTRY [ALLOWED/FORBIDDEN]</b>
<b>• Asset:</b> {{ $json.body.ticker }} | <b>BTC:</b> {{ $json.body.btc_price }}
<b>• Indicators:</b> SMC OB Low={{ $json.body.ob_low }} | VRVP POC={{ $json.body.volume_poc }} [status: price inside/above the volume, liquidity above/below]

<b>🎯 BYBIT ORDER PARAMETERS (Risk 100 USDT):</b>
<code>🟢 LONG LIMIT: [entry: POC + 10–20 points]
🛑 STOP LOSS: [1 point below OB Low]
📦 QTY: [computed coin count] contracts

🎯 TP1: [price] (40% + BE) | TP2: [price] (40%) | TP3: [price] (20%)</code>
```
