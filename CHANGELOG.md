# Changelog

Release sections are generated from `.changes/` fragments by
`tools/release_notes.sh --version X.Y.Z --apply` - do not edit them
by hand.

## [4.9.2] - 2026-11-13

### User-facing

_No user-visible changes._

### Codebase

#### orchestration
- [chore] Canonical fleet quality gates rollout - hazards docs, writer/reviewer/judge profiles, and commit-wrapper gates with negative tests. Why: Shared language-neutral reliability rules and mechanical enforcement (precommit re-grounding, whitelist scope, migration gate) replace drifting per-repo prompt lists; canonical source lives in ai_controller templates. (issue #81)
- [chore] Byte-for-byte adoption of the updated ai_controller canonical quality-gate set - agent profiles, hardened commit-wrapper gate scripts incl. new migration_pattern.sh, hazard docs, and controller-manager harness/development-cycle docs. Why: The upstream canonical absorbed the post-merge audit hardening (audit PR #87 superseded it) and expanded the negative-test suite to 53 checks; this repo adopts the canonical verbatim instead of carrying a local fork. (issue #88)

#### tools
- [feat] Restores tools/rs_dump.js (BTC-dump RS ranker) and adds per-dump entry candidates - RS>=1.5%, upper-half close, 24h-low false-break - with top-3 per dump and pooled stats, plus node:test coverage. Why: restore missing RS-scoring path for issue #8 hypothesis test. (issue #91, issue #8)
- [chore] >- Sync canonical repo_merge.sh (v0.15.5): pre-merge version_not_bumped gate blocks shipping-path merges without a [project].version bump. Why: >- Developer ruling 2026-11-12 (no_version_change incident): every merged PR must bump the version unless exempt (non-shipping diff or no-release label). Ref devin-session-bridge#162. (devin-session-bridge#162)

## [4.9.0] - 2026-11-11

### User-facing

#### feat
- Worker sessions now follow the director session model: short event-driven turns, one background executor, mandatory checkpoints. `docs` (issue #84, task 262)

### Codebase

#### docs
- [feat] Adopted canonical director session model section into controller-manager/harness.md; mid-turn inject proven impossible (canonical devin-session-bridge issue #137). Why: Canonical rollout of the director session model (task 262). A live ACP probe proved session/prompt is rejected mid-turn, so the event-driven model is the only viable variant. (issue #84, task 262)

## [4.8.20] - 2026-11-11

### User-facing

#### feat
- PRs changing files must now carry a release-notes record (a .changes fragment, a CHANGELOG change, or the no-changes-entry marker) - enforced by CI and the merge gate. `orchestration` (issue #79, canonical devin-session-bridge #135)

### Codebase

#### orchestration
- [feat] .changes/ convention adopted; tools/check_changes_entry.sh runs in lint on pull_request and inside repo_merge.sh pre-merge (missing_changes_entry). Why: canonical rollout preventing merges without a release record. (issue #79, canonical devin-session-bridge #135)
