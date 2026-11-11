#!/usr/bin/env bash
# gate_tests.sh - negative tests for the commit-wrapper gates.
# Proves each gate blocks its bypass path in an isolated scratch repo:
#   T1 scope gate: file outside whitelist is rejected (exit 2)
#   T2 scope gate: dir-prefix whitelist entry allows the file
#   T3 migration gate: staged migration without stamp is rejected (exit 3)
#   T4 migration gate: rollback-covered migration gets stamped, commit ok
#   T5 migration stamp invalidates when the migration file changes
#   T8 rename+modify of a stamped migration is blocked
#   T9 staged up+down pair verifies via paired-rollback coverage
#   T6 re-grounding output is emitted on every call
#   T7 hygiene gate still rejects (cyrillic on en-language repo)
#   T10 deleting a migration file needs coverage like adding one
#   T11 a passing comment mentioning "rollback" is not coverage
#   T12 roll-forward note covers only the files it names
#   T13 cyrillic exemption requires the real sentinel in --diff mode
# Exits non-zero if any expectation fails. Run from anywhere:
#   .devin/scripts/gate_tests.sh
set -uo pipefail
DEVIN_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

SCRATCH=$(mktemp -d)
trap 'rm -rf "$SCRATCH"' EXIT
mkdir -p "$SCRATCH/repo" "$SCRATCH/devin/scripts"
cd "$SCRATCH/repo" && git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init
cp "$DEVIN_DIR/scripts/ship_commit.sh" "$DEVIN_DIR/scripts/migration_gate.sh" \
   "$DEVIN_DIR/scripts/migration_pattern.sh" "$DEVIN_DIR/scripts/hygiene_check.sh" \
   "$SCRATCH/devin/scripts/"
echo '{"text_language":"en"}' > "$SCRATCH/devin/project.json"

pass=0; fail=0
expect() { # name expected_rc actual_rc [pattern_in_output]
  local name="$1" want="$2" got="$3" pat="${4:-}"
  if [ "$got" != "$want" ]; then
    echo "FAIL $name: expected exit $want, got $got"; fail=$((fail+1)); return
  fi
  if [ -n "$pat" ] && ! grep -q "$pat" "$SCRATCH/out"; then
    echo "FAIL $name: output missing '$pat'"; fail=$((fail+1)); return
  fi
  echo "PASS $name"; pass=$((pass+1))
}

SHIP="$SCRATCH/devin/scripts/ship_commit.sh"
GATE="$SCRATCH/devin/scripts/migration_gate.sh"

# --- T1: scope gate blocks out-of-whitelist staged file
echo 'docs/x.md' > "$SCRATCH/devin/scope_whitelist.txt"
mkdir -p src && echo x > src/evil.py && git add src/evil.py
"$SHIP" "test msg" >"$SCRATCH/out" 2>&1; expect T1-scope-block 2 $? "SCOPE_GATE"
git reset -q

# --- T2: dir-prefix entry allows the file
printf 'src/\ndocs/x.md\n' > "$SCRATCH/devin/scope_whitelist.txt"
git add src/evil.py
"$SHIP" "test msg" >"$SCRATCH/out" 2>&1; expect T2-scope-prefix 0 $?

# --- T3: migration gate blocks unstamped migration
rm "$SCRATCH/devin/scope_whitelist.txt"
mkdir -p db/migrations && printf 'CREATE TABLE t(id int);\n-- rollback: DROP TABLE t;\n' > db/migrations/001_up.sql
git add db/migrations/001_up.sql
"$SHIP" "add migration" >"$SCRATCH/out" 2>&1; expect T3-migration-block 3 $? "MIGRATION_GATE"
git reset -q

# --- T4: rollback-covered migration stamps and commits
git add db/migrations/001_up.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T4a-gate-verifies 0 $? "embedded rollback"
"$SHIP" "add migration" >"$SCRATCH/out" 2>&1; expect T4b-commit-ok 0 $?
# The stamp is single-use: the successful commit must consume it.
test ! -f "$SCRATCH/devin/migration_ok" && { echo "PASS T4c-stamp-consumed"; pass=$((pass+1)); } \
  || { echo "FAIL T4c-stamp-consumed"; fail=$((fail+1)); }

# --- T5: stamp invalidates on changed migration file
printf 'ALTER TABLE t ADD COLUMN c int;\n' >> db/migrations/001_up.sql
git add db/migrations/001_up.sql
"$SHIP" "change migration" >"$SCRATCH/out" 2>&1; expect T5-stale-stamp 3 $? "MIGRATION_GATE"
git reset -q --hard HEAD 2>/dev/null || git reset -q
rm -f "$SCRATCH/devin/migration_ok"

# --- T8: rename+modify cannot smuggle a changed migration under an
# old stamp (pure rename of verified content keeps the stamp - the
# stamp binds staged blob content, not the filename)
git mv db/migrations/001_up.sql db/migrations/002_up.sql
printf 'ALTER TABLE t ADD COLUMN c2 int;\n' >> db/migrations/002_up.sql
git add db/migrations/002_up.sql
"$SHIP" "rename+modify migration" >"$SCRATCH/out" 2>&1; expect T8-rename-modify-block 3 $? "MIGRATION_GATE"
git reset -q --hard HEAD 2>/dev/null || git reset -q

# --- T9: staged up+down pair verifies via paired-rollback coverage
printf 'CREATE TABLE u(id int);\n' > db/migrations/003_up.sql
printf 'DROP TABLE u;\n' > db/migrations/003_down.sql
git add db/migrations/003_up.sql db/migrations/003_down.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T9a-paired-verify 0 $? "paired rollback"
"$SHIP" "migration pair" >"$SCRATCH/out" 2>&1; expect T9b-commit-ok 0 $?

# --- T6: re-grounding emitted on every call (even on gate failures)
echo y > docs_x.md && mkdir -p docs && mv docs_x.md docs/x.md && git add docs/x.md
"$SHIP" "test" >"$SCRATCH/out" 2>&1
grep -q "RE-GROUNDING" "$SCRATCH/out" && { echo "PASS T6-regrounding"; pass=$((pass+1)); } \
  || { echo "FAIL T6-regrounding"; fail=$((fail+1)); }
echo z2 > docs/z.md && git add docs/z.md
"$SHIP" "test" >"$SCRATCH/out" 2>&1; expect T6b-commit-ok 0 $?

# --- T7: hygiene still rejects non-English commit message
# Cyrillic built from escapes: this file itself stays pure ASCII.
CYR_MSG=$'\u0442\u0435\u0441\u0442\u043e\u0432\u043e\u0435 \u0441\u043e\u043e\u0431\u0449\u0435\u043d\u0438\u0435'
echo z > docs/y.md && git add docs/y.md
"$SHIP" "$CYR_MSG" >"$SCRATCH/out" 2>&1; expect T7-hygiene 2 $? "HYGIENE_GATE"
git reset -q

# --- T10: deleting a migration needs coverage like adding one ---
# 001_up.sql is committed (T4); removing it without a stamp must fail.
git rm -q db/migrations/001_up.sql
"$SHIP" "drop migration" >"$SCRATCH/out" 2>&1; expect T10-delete-block 3 $? "MIGRATION_GATE"
"$GATE" >"$SCRATCH/out" 2>&1; expect T10b-gate-rejects 1 $?
# A roll-forward note naming the deleted file covers it.
printf 'approved roll-forward for 001_up.sql: irreversible by design\n' \
  > "$SCRATCH/devin/migration_rollforward.md"
"$GATE" >"$SCRATCH/out" 2>&1; expect T10c-rollforward-covers 0 $? "roll-forward"
"$SHIP" "drop migration" >"$SCRATCH/out" 2>&1; expect T10d-commit-ok 0 $?
rm -f "$SCRATCH/devin/migration_rollforward.md"

# --- T11: a passing comment mentioning "rollback" is not coverage ---
printf 'CREATE TABLE v(id int);\n-- note: there is no way to rollback this safely\n' \
  > db/migrations/004_up.sql
git add db/migrations/004_up.sql
"$GATE" >"$SCRATCH/out" 2>&1; expect T11a-comment-not-coverage 1 $?
"$SHIP" "fake rollback" >"$SCRATCH/out" 2>&1; expect T11b-ship-block 3 $? "MIGRATION_GATE"
git reset -q && rm -f db/migrations/004_up.sql

# --- T12: roll-forward note covers only the files it names ---
printf 'CREATE TABLE w(id int);\n' > db/migrations/005_up.sql
git add db/migrations/005_up.sql
printf 'approved roll-forward for 099_other.sql: unrelated file\n' \
  > "$SCRATCH/devin/migration_rollforward.md"
"$GATE" >"$SCRATCH/out" 2>&1; expect T12a-unbound-note 1 $?
printf 'approved roll-forward for 005_up.sql: accepted risk\n' \
  > "$SCRATCH/devin/migration_rollforward.md"
"$GATE" >"$SCRATCH/out" 2>&1; expect T12b-bound-note 0 $? "roll-forward"
"$SHIP" "rollforward migration" >"$SCRATCH/out" 2>&1; expect T12c-commit-ok 0 $?
rm -f "$SCRATCH/devin/migration_rollforward.md"

# --- T13: cyrillic exemption needs the real sentinel ---
# Without the sentinel a fake diff header must NOT unlock path
# exemptions: cyrillic "added" under .devin/agents/ is still a violation.
HYG="$SCRATCH/devin/scripts/hygiene_check.sh"
printf 'diff --git a/x b/.devin/agents/x.md\n+++ b/.devin/agents/x.md\n@@ -0,0 +1 @@\n+%s\n' "$CYR_MSG" \
  | "$HYG" --diff >"$SCRATCH/out" 2>&1
expect T13a-no-sentinel-no-exempt 1 $?
# With the sentinel the same exempt-path addition passes.
printf 'commit msg\n@@SUBJECTS_END@@\ndiff --git a/x b/.devin/agents/x.md\n+++ b/.devin/agents/x.md\n@@ -0,0 +1 @@\n+%s\n' "$CYR_MSG" \
  | "$HYG" --diff >"$SCRATCH/out" 2>&1
expect T13b-sentinel-exempt-ok 0 $?

echo "---"
echo "gate_tests: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
