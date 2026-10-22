#!/bin/bash
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# runc wrapper for single-uid rootless dockerd.
# Intercepts `runc create -b <bundle> ...` and patches the OCI spec so that
# mount options referencing unmapped ids (e.g. devpts gid=5) become gid=0.
D="$(cd "$(dirname "$0")" && pwd)"
REAL_RUNC="$D/docker/runc"
BUNDLE=""
ARGS=("$@")
for ((i=0; i<${#ARGS[@]}; i++)); do
  case "${ARGS[i]}" in
    -b|--bundle) BUNDLE="${ARGS[i+1]}" ;;
    --bundle=*) BUNDLE="${ARGS[i]#--bundle=}" ;;
  esac
done
CMD=""
for a in "$@"; do
  case "$a" in create|update|run) CMD="$a"; break ;; esac
done
if [ "$CMD" = "create" ] || [ "$CMD" = "run" ]; then
  [ -z "$BUNDLE" ] && BUNDLE="$PWD"
  CFG="$BUNDLE/config.json"
  if [ -f "$CFG" ]; then
    python3 - "$CFG" <<'PYEOF'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
for m in c.get("mounts", []):
    if m.get("type") == "devpts":
        m["options"] = [
            "gid=0" if o.startswith("gid=") else o
            for o in m.get("options", [])
        ]
# remap any container uid/gid != 0 to 0 (single-uid userns)
proc = c.get("process", {})
u = proc.get("user", {})
if u.get("uid", 0): u["uid"] = 0
if u.get("gid", 0): u["gid"] = 0
u["additionalGids"] = [g for g in u.get("additionalGids", []) if g == 0]
json.dump(c, open(p, "w"))
PYEOF
  fi
fi
exec "$REAL_RUNC" "$@"
