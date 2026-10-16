#!/usr/bin/env bash
# Product-line separation (security / life / clean).
#
# eufy ships several ecosystems that share a cloud account and nothing else. They must not leak into
# each other, and the leak is easy to introduce because their retail vocabulary overlaps and detection
# evidence is OR-ed. Two structural rules are checked here; the behavioural one (a capability never
# landing on another line's codec) is covered by capabilities/__tests__/line-partition.spec.ts.
#
#   1. Every capability module states its line, or inherits the `security` default. A module that
#      names another line's wire vocabulary while sitting on the default is the leak this catches.
#   2. No capability names an MQTT topic. Topics are transport vocabulary, built from the device
#      record in transport/mqtt/topics.ts; a capability that hard-codes one duplicates that knowledge
#      and has to be edited whenever the wire moves. Matches quoted literals only, so prose in a
#      comment is fine.
#
# Single source of truth for this check: package.json `guard:lines` and the CI workflow both run it
# (via `npm run verify`).
set -uo pipefail

fail=0

# 1. A capability that speaks of eufy_life without declaring itself part of that line.
for f in src/model/capabilities/*.ts; do
  # An unmatched glob expands to itself; skip it rather than grepping a path that does not exist.
  [ -f "$f" ] || continue
  case "$f" in */index.ts | */types.ts | */access.ts) continue ;; esac
  if grep -q "eufy_life" "$f" && ! grep -q 'line: "life"' "$f"; then
    echo "::error file=$f::names eufy_life but does not declare line: \"life\" (product-line leak)"
    fail=1
  fi
  if grep -q "eufy_security" "$f" && grep -q 'line: "life"' "$f"; then
    echo "::error file=$f::a life-line capability names eufy_security (product-line leak)"
    fail=1
  fi
done

# 2. A wire topic is transport vocabulary — no capability may name one.
topic_in_model=$(grep -rnE '"(cmd|synq)/' src/model --include='*.ts' | grep -v '__tests__' || true)
if [ -n "$topic_in_model" ]; then
  echo "::error::model/ names an MQTT topic — topics belong to transport/mqtt/topics.ts, which builds them from the device record:"
  echo "$topic_in_model"
  fail=1
fi

# 3. A Command kind names the WIRE ACTION, never the capability that emits it — `ff09-actuate`, not
#    `lock`. The kinds are the model↔transport boundary, so a capability name there couples the two
#    layers by vocabulary even though neither imports the other, and a second capability reusing the
#    same wire then has to send a command named after the first.
#    Matched per hyphen-separated SEGMENT against exact capability ids, so a wire feature whose own name
#    merely contains one (`ff09-autolock` — the auto-lock settings frame, not the `lock` capability) is
#    not a false positive.
caps='camera|light|smart_light|lock|siren|vacuum|battery|doorbell|motion|contact|leak|smoke|keypad|arming|storage|audio|video|snapshot|ptz|locate|smart_drop'
bad_kinds=$(grep -oE '\| \{ kind: "[a-z0-9_-]+"' src/core/contracts.ts 2>/dev/null |
  grep -oE '"[a-z0-9_-]+"' | tr -d '"' |
  while IFS= read -r kind; do
    echo "$kind" | tr '-' '\n' | grep -qxE "$caps" && echo "$kind"
  done)
if [ -n "$bad_kinds" ]; then
  echo "::error::a Command kind names a capability instead of the wire action it performs:"
  echo "$bad_kinds"
  fail=1
fi

exit "$fail"
