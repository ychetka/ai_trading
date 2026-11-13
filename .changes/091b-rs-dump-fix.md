---
type: fix
scope: tools
user_visible: false
breaking: false
user_summary: "-"
dev_summary: tools/rs_dump.js klines() now merges fetched kline pages through the exported mergePages() helper, returning deduped ascending [ts,close,high,low] bars instead of Map-entry pairs.
why: PR #92 stored [ts,close,high,low] bars as dedupe-map values but still returned map.entries() key/value pairs, so bars[i][1] was a nested array -> NaN RS -> zero detected dumps on live data (9 real dump windows over 14 days missed). mergePages() is exported and unit-tested so the regression cannot slip through again.
refs: issue #91, PR #92
---

## Spec impact
-
