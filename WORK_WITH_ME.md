<!--
Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
For commercial use, please contact the author.
-->

# Work With Me — Paid Validation Intake

This repository is an open-source R&D lab for multi-venue order-book
telemetry, liquidation-map reconstruction, and execution-accurate
backtesting. It publishes honest verdicts — including the ones that
kill hypotheses — with sample size, horizon, regime, and fee/friction
assumptions stated next to every R number.

If you have a trading hypothesis, a dataset question, or an automation
problem, there are two tracks.

## Track 1 — Free public backlog

Open a GitHub issue in this repository describing your hypothesis.
It joins the public research queue and gets validated in the open
when the queue reaches it. The verdict (positive or negative) is
published as an issue comment, and the methodology lands in the repo
if the hypothesis survives review.

A good hypothesis spec contains:

- instrument and venue(s), e.g. Bybit USDT-margined perps
- trigger: the exact event that marks a candidate
- entry and exit rules, deterministic enough to implement
- evaluation horizon and what "success" means (R, win rate, MAE/MFE)
- which fees/slippage model you expect applied

## Track 2 — Paid private fast-track

Two services lead, B2B-first:

1. **Custom hypothesis validation.** You bring a hypothesis (yours or
   extracted from a public source); the lab runs it against the same
   deterministic pipeline and telemetry shown in this repo. The
   deliverable is a verdict memo: sample size, R distribution, regime
   split, friction model, methodology appendix. NDA-friendly — the
   hypothesis and the memo stay private unless you ask otherwise.

   You pay for an honest verdict, not for the answer you want. A
   negative verdict is delivered with the same rigor — that is the
   product.

2. **n8n / AI-automation implementation blueprints.** Architecture and
   working patterns from this stack: rootless Docker + n8n deployment,
   multi-venue market-data collectors, schedule/state-machine design,
   versioned workflow patching, Telegram reporting, CI gates. Delivered
   as documentation plus reference implementation pointers — not the
   proprietary engine itself.

To start either: open a GitHub issue titled `intake: <short subject>`
with the hypothesis spec or the automation scope. Commercial terms are
agreed per engagement before work begins.

## Explicitly not for sale

- **Raw or derived multi-venue data feeds** — upstream exchange
  redistribution terms do not allow it; only aggregate analyses are
  published.
- **The engine source under a commercial license** — the repo is
  CC BY-NC 4.0; blueprints and consulting are how implementation
  knowledge is shared.
- **Real-time signals** — all public output is delayed (T+24h or
  longer) by policy; nothing here is a trading signal service.
- **Pooled capital / account management** — no external deposits are
  accepted or traded. Nothing in this repository or its outputs is
  investment advice.
