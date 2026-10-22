#!/usr/bin/env python3
# Copyright (c) 2026 Alexandr Varenic / ychetka. All rights reserved.
# Licensed under the Creative Commons Attribution-NonCommercial 4.0 International License (CC BY-NC 4.0).
# For commercial use, please contact the author.

# analyze_runs.py — daily channel report: what arrived in Telegram,
# which verdicts, which guards blocked.
# NOTE: parses the historical Russian-language bot output; the escaped
# pattern below (\u0412\u0435\u0440\u0434\u0438\u043a\u0442 = 'Verdict' in Cyrillic)
# matches the legacy corpus, not new messages.
#   python3 analyze_runs.py [hours=24]
import sqlite3, json, re, sys, os
from collections import Counter

DB = os.path.expanduser(
    '~/projects/trade-ai-analitic/docker-data/volumes/'
    'crypto-analyst_n8n_storage/_data/.n8n/database.sqlite')
H = int(sys.argv[1]) if len(sys.argv) > 1 else 24

db = sqlite3.connect(DB)
cutoff = db.execute("SELECT datetime('now','-%d hours')" % H).fetchone()[0]

rows = db.execute(
    "SELECT e.id, e.workflowId, e.status, e.startedAt, e.workflowVersionId"
    " FROM execution_entity e WHERE e.startedAt > ? ORDER BY e.id",
    (cutoff,)).fetchall()

# message texts live in execution_data as strings inside packed JSON
MSG_RE = re.compile(r'([🔥🎯ℹ️📊🔴🟢📡][^"]{10,600})')
VERDICT_RE = re.compile(r'(?:\u0412\u0435\u0440\u0434\u0438\u043a\u0442|Verdict): ([^\\"`]+?)(?:━━━━|\\u203b|$)')

msgs, runs = [], Counter()
for eid, wf, st, st_at, ver in rows:
    wf_tag = 'engine' if wf == 'UReb8vXm0vi47p48' else 'screener'
    runs[f'{wf_tag}:{st}'] += 1
    d = db.execute('SELECT data FROM execution_data WHERE executionId=?',
                   (eid,)).fetchone()
    if not d:
        continue
    for m in MSG_RE.finditer(d[0]):
        t = m.group(1).replace('\\n', ' ').strip()
        msgs.append((st_at, eid, t))

# dedup: one message appears in both node input and output
seen, uniq = set(), []
for st_at, eid, t in msgs:
    k = t[:120]
    if k not in seen:
        seen.add(k); uniq.append((st_at, eid, t))

info = [m for m in uniq if m[2].startswith(('🔥', 'ℹ️', '🎯'))]
summaries = [m for m in uniq if m[2].startswith('📊')]
digests = [m for m in uniq if m[2].startswith('📡')]
verdicts = [m for m in uniq if ('\u0412\u0435\u0440\u0434\u0438\u043a\u0442:' in m[2] or 'Verdict:' in m[2])]

green = [m for m in verdicts if m[2].startswith('🟢')]
red = [m for m in verdicts if m[2].startswith('🔴')]

reasons = Counter()
for _, _, t in red:
    mm = VERDICT_RE.search(t)
    reasons[(mm.group(1)[:80] if mm else '?')] += 1

armed_syms = Counter(re.search(r'<b>([A-Z0-9]+USDT)</b>', t).group(1)
                     for _, _, t in info
                     if t.startswith('🎯') and '<b>' in t)

print(f'=== Report for {H}h (since {cutoff} UTC) ===\n')
print('Runs:', dict(runs))
print(f'Messages to channel: {len(uniq)}')
print(f'  info (🔥/ℹ️/🎯): {len(info)}  | armed shots: {sum(armed_syms.values())}')
print(f'  summaries 📊: {len(summaries)}  digests 📡: {len(digests)}')
print(f'  verdicts: {len(verdicts)} — 🟢 {len(green)} / 🔴 {len(red)}\n')

if armed_syms:
    print('Armed by symbol:', dict(armed_syms))
if reasons:
    print('\nBlock reasons:')
    for r, c in reasons.most_common():
        print(f'  {c:3d}× {r}')
if green:
    print('\n🟢 SIGNALS:')
    for st_at, _, t in green:
        print(' ', st_at, t[:200])
