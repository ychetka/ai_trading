# Changelog

Release sections are generated from `.changes/` fragments by
`tools/release_notes.sh --version X.Y.Z --apply` - do not edit them
by hand.

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
