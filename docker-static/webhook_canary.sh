#!/bin/bash
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# webhook_canary.sh - surfaces Telegram getWebhookInfo error state for the
# shared-person moderation bot. This is the check that catches webhook
# delivery outages (like the 8443-forward outage on 2026-11-07).
#
# Usage: webhook_canary.sh [--env=<path/to/ENV>] [--max-age-min=<N>]
#   --env        file containing TELEGRAM_BOT_TOKEN (default: sibling
#                shared_person/ENV of this repo's parent dir)
#   --max-age-min  alert threshold on last_error_date age (default 60)
# Output: one status line; exit 0 = healthy/no recent error, 1 = recent
# webhook error (last_error_date within threshold), 2 = cannot evaluate.

ENV="${SP_ENV:-$(cd "$(dirname "$0")/../.." && pwd)/shared_person/ENV}"
MAX_AGE_MIN=60
for a in "$@"; do case "$a" in
  --env=*) ENV="${a#*=}";; --max-age-min=*) MAX_AGE_MIN="${a#*=}";; esac; done

[ -f "$ENV" ] || { echo "CANARY UNKNOWN: env file not found: $ENV"; exit 2; }
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV" | head -1 | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "CANARY UNKNOWN: TELEGRAM_BOT_TOKEN missing in $ENV"; exit 2; }

RESP=$(curl -sS --max-time 10 "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" 2>&1) \
  || { echo "CANARY UNKNOWN: telegram API unreachable"; exit 2; }

INFO=$(RESP="$RESP" MAX_AGE_MIN="$MAX_AGE_MIN" python3 - <<'PY'
import json,os,time
r=json.loads(os.environ['RESP'])
if not r.get('ok'):
    print('CANARY UNKNOWN: api not ok:',r.get('description')); raise SystemExit(2)
w=r['result']
led=w.get('last_error_date') or 0
le=w.get('last_error_message') or ''
age=int((time.time()-led)/60) if led else -1
url=w.get('url') or '(none)'
pend=w.get('pending_update_count') or 0
thr=int(os.environ['MAX_AGE_MIN'])
if led and age<=thr:
    print(f"CANARY FAIL: webhook error {age}m ago - {le} | url={url} pending={pend}")
    raise SystemExit(1)
print(f"CANARY OK: url={url} pending={pend} last_error={le or 'none'} ({'never' if age<0 else str(age)+'m ago'})")
PY
)
RC=$?
echo "$INFO"
exit $RC
