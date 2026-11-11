---
# type: fix | feat | refactor | chore | docs
type: fix
scope: orchestration
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Post-merge audit fixes for the fleet quality gates - strict sentinel-gated path exemptions in hygiene_check, deleted migrations inside the gate scope, directive-style embedded-rollback matching, file-bound roll-forward notes, single-use stamps, rename-safe NUL scope iteration, and a shared migration pattern file.
why: Independent code-reviewer audit of merged PRs #83/#85 found real bypasses (unstamped migration deletions, comment-only rollback coverage, global roll-forward note, reusable stamp, fake diff headers steering cyrillic exemptions) that are now closed with new negative tests.
refs: "issue #86"
---

## Spec impact
-
