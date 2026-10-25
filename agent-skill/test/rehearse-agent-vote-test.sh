#!/usr/bin/env bash
# Rehearsal of scripts/agent_vote_test.sh on a LOCAL validator (no mainnet, no real key), the way the live test will be run:
#   status -> open (refused: no coins yet) -> send (plan, real, repeat) -> open (real, repeat: still ONE proposal) ->
#   the agent votes through the real `onstate` CLI with the FAKE OKX wallet -> status -> finish (execute + close, repeat).
#
#   bash agent-skill/test/rehearse-agent-vote-test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

unset KEYPAIR TREASURY_MINT PROGRAM_ID GOVERNANCE_MINT ANCHOR_WALLET HTTP_CONFIRM PARAMS PARAM_OVERRIDES CONFIRM AGENT_WALLET AGENT_COINS OWNER_KEEP_COINS

WORK="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/vote-rehearsal.XXXXXX")}"
mkdir -p "$WORK/bin"
PORT=8899
RPC="http://127.0.0.1:$PORT"
SO="$REPO/target/deploy/onchain_state_solana.so"
[ -f "$SO" ] || { echo "missing $SO - run 'anchor build' first"; exit 1; }
PROGRAM_ID="$(node -e "console.log(require('$REPO/idl/onchain_state_solana.json').address)")"
echo "work dir: $WORK"

if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is already in use (another validator?) - stop it first"; exit 1; fi

VALIDATOR_PID=""
cleanup() { [ -n "$VALIDATOR_PID" ] && kill "$VALIDATOR_PID" 2>/dev/null || true; }
trap cleanup EXIT

solana-test-validator --reset --quiet --ledger "$WORK/ledger" --rpc-port "$PORT" \
  --bpf-program "$PROGRAM_ID" "$SO" --limit-ledger-size 500000000 >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!
for i in $(seq 1 90); do
  if curl -s -m 2 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -q '"ok"'; then break; fi
  sleep 1
  [ "$i" = 90 ] && { echo "validator did not start"; tail -20 "$WORK/validator.log"; exit 1; }
done
echo "validator is up"

for k in owner admin agent; do solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/$k.json" >/dev/null; done
OWNER="$(solana-keygen pubkey "$WORK/owner.json")"
ADMIN="$(solana-keygen pubkey "$WORK/admin.json")"
AGENT="$(solana-keygen pubkey "$WORK/agent.json")"
solana airdrop 100 "$OWNER" --url "$RPC" >/dev/null
solana airdrop 1 "$AGENT" --url "$RPC" >/dev/null

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$WORK/owner.json"
ts() { npx ts-node "$@"; }

echo "== coin and state (voting window 45 s)"
NAME="Rehearsal" SYMBOL=RHS INITIAL_SUPPLY=1000000 OUT="$WORK/mint.json" ts scripts/create_mint.ts >"$WORK/create_mint.log" 2>&1 || { cat "$WORK/create_mint.log"; exit 1; }
MINT="$(solana-keygen pubkey "$WORK/mint.json")"
export GOVERNANCE_MINT="$MINT"
OWNERS_AUTHORITY="$OWNER" ADMIN_AUTHORITY="$ADMIN" PRESIDENT="$OWNER" PARAMS=test \
  PARAM_OVERRIDES='{"votingPeriodSecs":45,"timelockSecs":0,"spendCooldownSecs":0}' ts scripts/initialize.ts >"$WORK/initialize.log" 2>&1 || { cat "$WORK/initialize.log"; exit 1; }
AMOUNT=1 ts scripts/fund_treasury.ts >"$WORK/fund.log" 2>&1 || { cat "$WORK/fund.log"; exit 1; }

# settings of the script under test (small numbers instead of the live ones)
export AGENT_WALLET="$AGENT" AGENT_COINS=1000 OWNER_KEEP_COINS=1000
export GOV2_STATE="$WORK/vote-test.state.json" GOV2_LOG="$WORK/vote-test.log"
vt() { ts scripts/agent_vote_test.ts "$@"; }
vt_yes() { CONFIRM=yes ts scripts/agent_vote_test.ts "$@"; }
expect() { # expect "<text>" command...   runs the command (it may fail), prints it when the text is missing
  local want="$1"; shift
  local got; got="$("$@" 2>&1)" || true
  echo "$got" | grep -q -- "$want" || { echo "$got"; echo "FAIL: expected \"$want\""; exit 1; }
  echo "  ok: $want"
}

echo "== before anything"
expect "no test proposal yet" vt status
expect "run the step 'send' first" vt_yes open
expect "DRY RUN - nothing was sent" vt send
echo "== send the coins (twice: the second run must do nothing)"
expect "send 1,000 coins to the agent wallet" vt_yes send
expect "already holds 1,000 coins" vt_yes send
echo "== open the proposal (twice: still ONE proposal)"
expect "is open" vt_yes open
expect "is open" vt_yes open
CREATED="$(grep -c 'create_proposal' "$GOV2_LOG" || true)"
[ "$CREATED" = "1" ] || { echo "FAIL: create_proposal appears $CREATED times in the journal, expected 1"; cat "$GOV2_LOG"; exit 1; }
echo "  ok: exactly one proposal was created"
ID="$(sed -n 's/.*proposal #\([0-9]*\) is open.*/\1/p' "$GOV2_LOG" | tail -1)"
[ -n "$ID" ] || { cat "$GOV2_LOG"; echo "FAIL: could not read the proposal id"; exit 1; }
echo "  proposal id $ID"

echo "== the agent votes: real onstate CLI + FAKE OKX wallet"
cat > "$WORK/bin/onchainos" <<SHIM
#!/bin/sh
export FAKE_OKX_KEYPAIR="$WORK/agent.json"
export FAKE_OKX_RPC="$RPC"
export FAKE_OKX_DIR="$WORK/fake-okx"
exec node "$HERE/fake-onchainos.js" "\$@"
SHIM
chmod +x "$WORK/bin/onchainos"
onstate() { ONSTATE_RPC_URL="$RPC" ONSTATE_MINT="$MINT" ONSTATE_OKX_BIN="$WORK/bin/onchainos" node "$REPO/agent-skill/cli/bin/onstate.js" "$@"; }
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=process.argv[1].split(".").reduce((a,k)=>a&&a[k],j);console.log(v===undefined?"":v)})' "$1"; }
LISTED="$(onstate proposals --limit 5 | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const p=j.proposals.find(x=>x.id===Number(process.argv[1]));console.log(p&&p.you&&p.you.enrolled&&p.stage==="VOTING"?"enrolled-and-open":"NOT-READY "+JSON.stringify(p&&p.you))})' "$ID")"
[ "$LISTED" = "enrolled-and-open" ] || { echo "FAIL: the agent wallet does not see the proposal as open + enrolled: $LISTED"; exit 1; }
echo "  ok: the agent wallet sees proposal $ID as open and itself as enrolled"
PREVIEW="$(onstate vote --proposal "$ID" --no)"
RID="$(echo "$PREVIEW" | jget requestId)"
[ -n "$RID" ] || { echo "$PREVIEW"; echo "FAIL: no requestId in the vote preview"; exit 1; }
EXEC="$(onstate execute --request-id "$RID")"
SIG="$(echo "$EXEC" | jget txHash)"
[ -n "$SIG" ] || { echo "$EXEC"; echo "FAIL: the vote was not sent"; exit 1; }
echo "  ok: the agent voted AGAINST, tx ${SIG:0:16}..."
expect "HAS VOTED" vt status
expect "the voting is still running" vt_yes finish

echo "== finish after the voting window (execute + close, twice)"
echo "  (waiting for the end of the 45 s window)"
OUT=""
for i in $(seq 1 20); do
  OUT="$(vt_yes finish 2>&1)" || true
  echo "$OUT" | grep -q "the voting is still running" || break
  sleep 3
done
for want in "execute #" "close voter record #$ID owner" "close voter record #$ID agent" "close proposal #$ID"; do
  echo "$OUT" | grep -q -- "$want" || { echo "$OUT"; echo "FAIL: expected \"$want\""; exit 1; }
  echo "  ok: $want"
done
expect "already closed" vt_yes finish
FAILS="$(grep -cE 'FAIL  |[1-9][0-9]* FAILED|… FAILED' "$GOV2_LOG" || true)"
[ "$FAILS" = "0" ] || { cat "$GOV2_LOG"; echo "FAIL: the journal contains failures"; exit 1; }
echo "ALL CHECKS PASSED (journal: $GOV2_LOG)"
