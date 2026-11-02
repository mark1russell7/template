#!/usr/bin/env bash
# Tests match.jq of the action "changes" and summary.jq of the action "gate-summary". actions-test.yml runs it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fails=0

# match <want> <files, comma separated> <paths> [<paths-ignore>]
match() {
  local got
  got=$(printf '%s' "$2" | tr ',' '\n' | jq -R -s -r --arg paths "$3" --arg ignore "${4:-}" -f "$here/changes/match.jq")
  if [ "$got" = "$1" ]; then echo "ok   match $1: $2 | $3 | ${4:-}"; else echo "FAIL match: got $got, want $1: $2 | $3 | ${4:-}"; fails=$((fails + 1)); fi
}

match true  "packages/core/src/a.ts"            "packages/core/src/**"
match false "packages/core/README.md"           "packages/core/src/**"
match true  "pilots/src/ireko-x.ts"             "pilots/src/ireko-*.ts"
match false "pilots/src/sub/ireko-x.ts"         "pilots/src/ireko-*.ts"
match true  "a.js"                              "*.js"
match false "lib/a.js"                          "*.js"
match true  "lib/deep/a.js"                     "**.js"
match true  "src/a.ts"                          "**/*.ts"
match true  "a.ts"                              "**/*.ts"
match true  "corpus/a(1)+b.json"                "corpus/**"
match false "x.yml"                             ".github/workflows/x.yml"
match true  ".github/workflows/x.yml"           $'  .github/workflows/x.yml  \n# a comment'
match false "src/a.test.ts"                     $'src/**\n!src/**/*.test.ts'
match true  "src/a.test.ts,src/b.ts"            $'src/**\n!src/**/*.test.ts'
match true  "src/a.test.ts"                     $'src/**\n!src/**/*.test.ts\nsrc/a.test.ts'
match false "docs/x.md"                         "**" "docs/**"
match true  "docs/x.md,src/y.ts"                "**" "docs/**"
match false "packagesX/core/src/a.ts"           "packages/core/src/**"
match false ""                                  "**"

# summary <want: ok or FAIL> <needs JSON> [<allow-skip>]
summary() {
  local out verdict
  out=$(printf '%s' "$2" | jq -r --arg changes changes --arg allow "${3:-}" -f "$here/gate-summary/summary.jq")
  if grep -q '^FAIL' <<< "$out"; then verdict=FAIL; else verdict=ok; fi
  if [ "$verdict" = "$1" ]; then echo "ok   summary $1: $2"; else echo "FAIL summary: got $verdict, want $1: $2"; echo "$out"; fails=$((fails + 1)); fi
}

c_true='"changes":{"result":"success","outputs":{"match":"true"}}'
c_false='"changes":{"result":"success","outputs":{"match":"false"}}'
summary ok   "{$c_true,\"gate\":{\"result\":\"success\",\"outputs\":{}}}"
summary FAIL "{$c_true,\"gate\":{\"result\":\"failure\",\"outputs\":{}}}"
summary FAIL "{$c_true,\"gate\":{\"result\":\"cancelled\",\"outputs\":{}}}"
summary FAIL "{$c_true,\"gate\":{\"result\":\"skipped\",\"outputs\":{}}}"
summary ok   "{$c_true,\"gate\":{\"result\":\"skipped\",\"outputs\":{}}}" "gate"
summary ok   "{$c_false,\"gate\":{\"result\":\"skipped\",\"outputs\":{}}}"
summary FAIL "{$c_false,\"gate\":{\"result\":\"failure\",\"outputs\":{}}}"
summary FAIL '{"changes":{"result":"failure","outputs":{}},"gate":{"result":"skipped","outputs":{}}}'
summary FAIL '{"changes":{"result":"success","outputs":{}},"gate":{"result":"skipped","outputs":{}}}'
summary FAIL '{"gate":{"result":"skipped","outputs":{}}}'
summary ok   '{"gate":{"result":"success","outputs":{}}}'
summary FAIL '{}'

if [ "$fails" -gt 0 ]; then echo "::error::$fails test(s) of the gate actions failed"; exit 1; fi
echo "Each test of the gate actions passed."
