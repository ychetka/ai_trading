---
# type: fix | feat | refactor | chore | docs
type: chore
scope: orchestration
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Byte-for-byte adoption of the updated ai_controller canonical quality-gate set - agent profiles, hardened commit-wrapper gate scripts incl. new migration_pattern.sh, hazard docs, and controller-manager harness/development-cycle docs.
why: The upstream canonical absorbed the post-merge audit hardening (audit PR #87 superseded it) and expanded the negative-test suite to 53 checks; this repo adopts the canonical verbatim instead of carrying a local fork.
refs: "issue #88"
---

## Spec impact
-
