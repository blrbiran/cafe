#!/usr/bin/env bash
# Simulate the two-machine test (handoff section 6) with three local Daemons.
# A = Root (47831), B = child with the Barista (47832), C = child Customer (47833).
# No model calls: B's Barista is `cafe serve --exec` printing the prompt back.
# Usage: bash scripts/sim-hosts.sh   (ports 47831-47833 must be free)
set -u
REPO=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d "${TMPDIR:-/tmp}/cafe-sim.XXXX")
TOKEN=simtoken0123456789
cafe() { node "$REPO/packages/cli/bin/cafe.js" "$@"; }
mk() { # name port extra
  mkdir -p "$W/$1"
  # Tests and local simulations use plaintext: the production default is TLS on a fixed port
  # (4778), and these scratch Daemons must not fight the real Root or each other for it.
  printf 'port: %s\nhost: %s\nadvertise: 127.0.0.1\ntoken: %s\ndiscovery: false\nsecurity:\n  mode: plaintext\n%s' "$2" "$1" "$TOKEN" "$3" > "$W/$1/config.yml"
}
mk A 47831 $'mode: root\n'
mk B 47832 $'root: 127.0.0.1:47831\n'
mk C 47833 $'root: 127.0.0.1:47831\n'
mkdir -p "$W/bdir"
printf 'name: echo\ndescription: Echoes questions back for testing.\nrole: barista\nconcurrency: 1\n' > "$W/bdir/.cafe"
at() { local h=$1; shift; CAFE_HOME="$W/$h" cafe "$@"; }
step() { echo; echo "=== $*"; }
threads_on_A() { curl -s "http://127.0.0.1:47831/api/threads?token=$TOKEN" -H "authorization: Bearer $TOKEN" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=Array.isArray(j)?j:(j.threads??[]);console.log("threads on A:",a.length)})'; }

at A daemon start; at B daemon start; at C daemon start
(cd "$W/bdir" && CAFE_HOME="$W/B" cafe serve --exec "sleep \$(cat $W/slow 2>/dev/null || echo 0); printf 'B got: %s' \"\$(cat)\"" --dir "$W/bdir" > "$W/serve.log" 2>&1 &)
sleep 3

step "1. C asks B's Barista through the Root"
at C ask --to echo "hello from C" | tail -3
threads_on_A
TID=$(at C threads --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const a=Array.isArray(j)?j:j.threads;console.log(a[0].threadId)}catch{}})')
step "2. follow-up goes back to the same Barista (thread $TID)"
[ -n "$TID" ] && at C ask --thread "$TID" "second turn" | tail -3

step "3. Root A stops; C still reaches B over a direct link"
at A daemon stop; sleep 3
at C ask --to echo "while root is down" | tail -3

step "4. Root A returns; the direct-link conversation is backfilled"
at A daemon start; sleep 8
threads_on_A

step "5. A and B both down: C fails with root_unreachable"
at A daemon stop; at B daemon stop; sleep 3
at C ask --to echo "nobody home" 2>&1 | tail -3

step "6. B restarts mid-question"
at A daemon start; at B daemon start; sleep 8
echo 6 > "$W/slow"
at C agents
( sleep 2; at B daemon stop; sleep 1; at B daemon start ) &
at C ask --to echo "slow one" 2>&1 | tail -4
wait
sleep 3
echo "serve processes: $(pgrep -f "serve --exec" | wc -l | tr -d ' ')"

step "cleanup"
pkill -f "$W/bdir" 2>/dev/null
at C daemon stop; at B daemon stop; at A daemon stop
echo "logs in $W"
