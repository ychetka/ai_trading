<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] Task: deploy the composite prompt (SMC + VRVP + RSI + Stoch)

> Historical task spec for updating the `OpenRouter Free AI` node's
> `jsonBody` in the n8n workflow. The workflow is retired; kept for
> history.

Goal: make the AI decide on exact oscillator math passed from
TradingView, not on narrative.

The new `jsonBody` set `model: meta-llama/llama-3-8b-instruct:free` with
a single user message whose content was (translated):

```
You are a professional risk manager of the crypto futures market.
Produce an ultra-compact, sniper trade verdict (≤10 lines) from strict
indicator math.

Live metrics from TradingView:
- Asset: {{ $json.body.ticker }}
- Current price: {{ $json.body.price }}
- SMC OB Low (block lower bound): {{ $json.body.ob_low }}
- VRVP POC (whale volume): {{ $json.body.volume_poc }}
- Alt RSI: {{ $json.body.rsi }} | Alt Stochastic K: {{ $json.body.stoch_k }}
- Leader BTC/USDT: {{ $json.body.btc_price }}

ANALYSIS LOGIC:
1. Oscillators: if RSI > 70 or Stochastic K > 80 → extreme local alt
   overheat. If BTC is also high (>84k) → hard FORBIDDEN on market entry.
2. Liquidation levels: the retail long stop pool is clustered between
   current price and OB Low, right under VRVP POC. A squeeze is expected.
3. Strategy: ONLY a LONG LIMIT trap at VRVP POC, stop 1 tick below OB Low.
4. Sizing at 100 USDT risk: Qty = 100 / (volume_poc - (ob_low - 0.001)).

OUTPUT STRICTLY THIS HTML TEMPLATE FOR TELEGRAM:

<b>[🔴/🟢] MARKET ENTRY [FORBIDDEN/ALLOWED]</b>
<b>• Composite audit:</b> {{ $json.body.ticker }} | <b>BTC:</b> {{ $json.body.btc_price }}
<b>• Structure:</b> SMC OB={{ $json.body.ob_low }} | VRVP POC={{ $json.body.volume_poc }}
<b>• Oscillators:</b> RSI={{ $json.body.rsi }} (Stoch K={{ $json.body.stoch_k }}) -> [overbought / cooled]
<b>• Liquidations:</b> retail stop pool modelled under POC down to {{ $json.body.ob_low }}. Expecting squeeze.

<b>🎯 BYBIT SNIPER TRAP (Risk 100 USDT):</b>
<code>🟢 LONG LIMIT: {{ $json.body.volume_poc }}
🛑 STOP LOSS: [compute: OB Low - 1 tick]
📦 QTY: [compute: 100 / (volume_poc - OB Low)] contracts

🎯 TP1: [entry + 2%] (move to BE) | TP2: [entry + 5%]</code>
```
