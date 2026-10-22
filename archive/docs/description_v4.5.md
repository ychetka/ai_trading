<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# [ARCHIVED] System spec: SMC AI Analyst v4.5 — internal SMC detection

> Retired. Deactivated 2026-10-23. Kept for history — see STRATEGY.md.
> Note: this is the SMC-era v4.5. The active Donchian-era spec is
> `description_v4.5.1.md` at the repo root (same version lineage,
> different strategy — do not confuse).

LuxAlgo does not export OB/POC plots (confirmed live 2026-10-06), so
v4.5 moved all SMC computation inside Trade Calc, computed from Bybit
klines. The TV alert became a pure event trigger.

## New minimal alert payload contract

```json
{"ticker":"{{ticker}}","price":"{{close}}","event":"equal_lows"}
```

`event` — a free-text tag set manually when creating the alert
(`equal_lows`, `ob_tap`, `sweep`…). The engine validates the type: for
`equal_lows` our own JS detector must confirm it; other types pass
through unconfirmed (extension point).

## Bybit Klines: limit 16 → 200

One node now feeds both the ATR guard and the SMC detector (~8.3 days
of 1H history).

## Internal SMC detection in Trade Calc

| Construct | Formula | Parameter |
|---|---|---|
| Swing low | low below `swing_k` neighbours on each side | `swing_k` = 3 |
| Equal Lows | ≥2 swing lows, divergence ≤ `eql_tol_pct`% | `eql_tol_pct` = 0.3 |
| OB Low | low of the last bearish candle followed by a close ≥ `ob_impulse_pct`% higher within ≤3 bars | `ob_impulse_pct` = 1 |
| VRVP POC | hlc3 volume binned into `poc_bins` price bins over `smc_lookback` bars; POC = centre of max-volume bin | `poc_bins` = 40, `smc_lookback` = 200 |
| RSI | Wilder RSI(14) over all window bars | — |
| Stoch %K | (c − llv14) / (hhv14 − llv14) × 100, SMA(3)-smoothed | — |

## New guards in the chain

- `klines < 60 bars` → block ("insufficient data")
- `event=equal_lows && !eqlFound` → block ("JS detector did not confirm
  Equal Lows — desync from the trigger") — protection against false
  LuxAlgo firings and foreign alerts
- `ob/poc = NaN` → block ("no SMC structure in the window")

Alert fields `ob_low/volume_poc/rsi/stoch_k` are no longer read — the
only source of truth is exchange candles.

## Important infrastructure fix (found in this iteration)

n8n executes a versioned snapshot, not the draft: three pointers
(`workflow_entity.versionId`, `activeVersionId`,
`workflow_published_version.publishedVersionId`) must all point to a
fresh `workflow_history` row.

## Verification

- Harness on the live API (HBAR): EQL found by our detector, OB=0.10025,
  POC=0.10454, RSI 41.6, Stoch 25.4, ATR 0.83%; price below POC →
  correct "squeeze already played out" block.
- Exec #39 (live): success, compact Telegram format.

## What was next (historical)

- TV alerts: LuxAlgo SMC → Equal Lows → 3-field payload → 5 tickers
  (HBAR, LTC, LINK, XLM, ENA), 1H.
- Signal journal → factual WR after 20–30 firings.
- v5 (autonomous universe scanner) stayed in the backlog — 80% of its
  engine already lived inside Trade Calc.
