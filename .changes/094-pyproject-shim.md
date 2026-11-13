---
type: chore
scope: orchestration
user_visible: false
breaking: false
user_summary: "-"
dev_summary: Added a minimal pyproject.toml shim that carries [project].version = "4.9.4" as the single source of truth for the release tooling.
why: repo_release.sh requires [project].version on the base head to derive the release tag; the shim restores the standard release path. Version 4.9.4 sits above the latest tag v4.9.3, so the post-merge auto-release mints tag v4.9.4.
refs: issue #94
---

## Spec impact
-
