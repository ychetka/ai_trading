# Roadmap

Public project roadmap. Consolidates developer directives with
consolidated partner advisory (product, market, strategy review,
2026-11-05). This file tracks decided positioning; item-level
verdict history lives in the working session layer.

## Positioning

Open-source R&D lab for 13-venue order-book telemetry,
liquidation reconstruction, and execution-accurate backtesting.

Slogan: "95% of Crypto-Twitter strategies fail 13-venue
telemetry. Bring yours - we will prove it." (Industrial-Grade
Myth-Busting.)

## Publication rules

- Never real-time signals. Telemetry is published with a 24-72h
  delay.
- R-metrics are always reported with sample size, horizon,
  market regime, and fees.
- Weekly "Live Decay Report" covering losing strategies too.
- Aggregated analyses and charts only - no redistributable
  raw or derived multi-venue order-book feeds (exchange ToS).

## Free / paid boundary

- Free: What/Why - equity curves, R-metrics, architecture
  notes, strategy verdicts. Public verdicts are the top-of-funnel
  trust layer and stay public.
- Paid: private custom hypothesis validation and implementation
  blueprints (n8n / AI-systems). We do not sell raw feed access
  or engine code (support burden is incompatible with a solo
  project).

## Audience

- Community readers (dreamers): source of hypotheses and volume,
  not signal clients.
- Payer Tier 1: indie quants / prosumer systematics - clean L2
  dumps, pipeline tooling, hosted telemetry.
- Payer Tier 2 (later, inbound only): prop/pod leads and HNW
  systematics under NDA.

## Marketing and funnel

- Phase 1 channels: Habr, r/algotrading, X/FinTwit - text
  teardowns with GitHub links only. Optional: Smart-Lab.
- Phase 2: TradingView (Ideas + Update-Idea + signature link);
  requires a feasibility check for visualizing order-book
  telemetry on a natively OHLCV platform.
- Meta platforms (FB/IG) are out of scope: link suppression and
  finance-word friction at zero budget is not worth it.
- Community home: a single sober "Research Lab Log" Telegram
  channel fed by the funnel; no hype persona, no posting into
  third-party publics.
- Validation gates before funnel build-out:
  - Habr/reddit teardown -> GitHub-only links -> TG invite in
    README; target views->stars->TG joins above 2%.
  - Tier-1 smoke test: "L2 dumps + custom venue adapters, DM
    for schema" line in README; measure indie-quant vs prop
    DM ratio.
- Deposit-pool idea is restricted to zero external capital
  (pooling third-party deposits is an unlicensed collective
  investment). Options kept: explicit [SIMULATED PAPER ENGINE]
  labels, or 100% developer-funded micro accounts ($50-500) to
  measure backtest-vs-live slippage delta. The engineering goal
  is execution realism, not P&L.
- Legal prerequisite: entity registration before connecting
  any live exchange API key with trade permissions.
- Brand budget guard: 15-30 min/day requires automated teardown
  generation from backtest engine output.

## Market recap format

- Replaced the near-real-time "volatility ticker" idea (de facto
  signals, violates the delay rule, ToS risk) with a "T+24h
  Volatility/Liquidation Cascade Autopsy": high-resolution
  replay published after the move. Proves data capture quality
  without signal classification.

## MVP artifacts

1. Pinned manifest + live strategy scoreboard by R.
2. Teardown showcase: SMC -0.16R vs Donchian +0.68R.
3. Dual-track hypothesis intake: free public backlog vs paid
   private fast-track.
4. "Work With Me / Paid Validation Intake" page.
5. Deferred: leaderboard and mutation voting (gamification only
   makes sense once a community exists).

## Monetization order

1. B2B-first: custom hypothesis validation and n8n automation
   services lead - a few conversions monetize a small audience.
2. Platform-native paid scripts move to could-have, after the
   scoreboard shows sustained demand for a specific strategy.
3. Long arc kept, framed on execution quality (slippage and
   toxicity reduction across venues), not alpha:
   Market Telemetry -> Execution Simulation -> Multi-Venue
   OMS/EMS infrastructure.

## Active research pipeline

- Issue #47: optimal volatility entry - hybrid order-book walls
  + reconstructed liquidation map + event model.
- Issue #3 (Re-entry at next liquidity zone): persistent-wall
  liquidity zones - ready for preliminary validation, 11k+
  outcomes.
- Issue #22 (Whale funding-rate split): whale directional
  conviction / insider-short tracking - weak replication so
  far; watching for more flagged spikes.
- Donchian forward test: accumulating virtual trades.
- Known gaps: automatic signal->outcome joiner, minute-scale
  wall cadence, regime diversity (all recent tags are neutral).

## Infrastructure state

- Release line v4.8.x; required checks on main: lint +
  unit-tests; CODEOWNERS review gating.
- No open production PRs; earlier research PRs #10-14 remain
  open but parked.
