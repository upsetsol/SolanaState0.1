#!/usr/bin/env bash
# Rehearsal of scripts/winddown_treasury.ts on a LOCAL validator (no mainnet, no real key) with the real contract bytecode:
#   status -> open (plan) -> open (real, repeated: still the same number of proposals) -> finish too early (refused to run ahead) ->
#   finish after the voting windows (execute in order, close, unwrap) -> finish again (nothing left to do).
# It proves the part that matters: the 30 % ceiling of one spend and the rounding of every piece against the real program.
#
#   bash scripts/rehearse_winddown.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"
unset KEYPAIR TREASURY_MINT PROGRAM_ID GOVERNANCE_MINT ANCHOR_WALLET HTTP_CONFIRM PARAMS PARAM_OVERRIDES CONFIRM MIN_PIECE MAX_PROPOSALS ALLOW_COOLDOWN

WORK="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/winddown-rehearsal.XXXXXX")}"
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

for k in owner admin; do solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/$k.json" >/dev/null; done
OWNER="$(solana-keygen pubkey "$WORK/owner.json")"
ADMIN="$(solana-keygen pubkey "$WORK/admin.json")"
solana airdrop 100 "$OWNER" --url "$RPC" >/dev/null

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$WORK/owner.json"
ts() { npx ts-node "$@"; }

echo "== coin and state (voting window 45 s, no pause between spends), treasury = 1 SOL"
NAME="Rehearsal" SYMBOL=RHS INITIAL_SUPPLY=1000000 OUT="$WORK/mint.json" ts scripts/create_mint.ts >"$WORK/create_mint.log" 2>&1 || { cat "$WORK/create_mint.log"; exit 1; }
MINT="$(solana-keygen pubkey "$WORK/mint.json")"
export GOVERNANCE_MINT="$MINT"
OWNERS_AUTHORITY="$OWNER" ADMIN_AUTHORITY="$ADMIN" PRESIDENT="$OWNER" PARAMS=test \
  PARAM_OVERRIDES='{"votingPeriodSecs":45,"timelockSecs":0,"spendCooldownSecs":0}' ts scripts/initialize.ts >"$WORK/initialize.log" 2>&1 || { cat "$WORK/initialize.log"; exit 1; }
AMOUNT=1 ts scripts/fund_treasury.ts >"$WORK/fund.log" 2>&1 || { cat "$WORK/fund.log"; exit 1; }

export GOV2_STATE="$WORK/wd.state.json" GOV2_LOG="$WORK/wd.log"
wd() { ts scripts/winddown_treasury.ts "$@"; }
wd_yes() { CONFIRM=yes ts scripts/winddown_treasury.ts "$@"; }
expect() { # expect "<text>" command...   runs the command (it may fail), prints it when the text is missing
  local want="$1"; shift
  local got; got="$("$@" 2>&1)" || true
  echo "$got" | grep -q -- "$want" || { echo "$got"; echo "FAIL: expected \"$want\""; exit 1; }
  echo "  ok: $want"
}
owner_sol() { solana balance "$OWNER" --url "$RPC" | awk '{print $1}'; }

echo "== plan only"
expect "planned series" wd status
expect "DRY RUN - nothing was sent" wd open
[ ! -f "$GOV2_STATE" ] || { echo "FAIL: the dry run wrote a state file"; exit 1; }
echo "  ok: the dry run left nothing behind"

echo "== open the series (twice: still the same proposals)"
SOL_BEFORE="$(owner_sol)"
expect "proposals are open and voted FOR" wd_yes open
N="$(node -e 'console.log(JSON.parse(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).done.series).length)' "$GOV2_STATE")"
echo "  the series has $N proposals"
expect "proposals are open and voted FOR" wd_yes open
CREATED="$(grep -c 'create_proposal' "$GOV2_LOG" || true)"
[ "$CREATED" = "$N" ] || { echo "FAIL: create_proposal appears $CREATED times in the journal, expected $N"; cat "$GOV2_LOG"; exit 1; }
echo "  ok: exactly $N proposals were created"
VOTES="$(grep -c 'vote FOR' "$GOV2_LOG" || true)"
[ "$VOTES" = "$N" ] || { echo "FAIL: vote FOR appears $VOTES times in the journal, expected $N"; exit 1; }
echo "  ok: exactly $N votes"

echo "== too early"
expect "the voting is still running" wd_yes finish

echo "== rent: the voting windows have ended but nothing is executed yet -> only voter records can be closed, no proposal"
echo "  (waiting for the end of the 45 s windows)"
sleep 50
RENT_OUT="$(wd_yes rent 2>&1)" || true
# the earlier "too early" finish may already have executed and closed the first piece(s): count what rent really saw
M="$(echo "$RENT_OUT" | sed -n 's/.* proposals and \([0-9]*\) voter records are still open.*/\1/p' | head -1)"
{ [ -n "$M" ] && [ "$M" -ge $((N - 2)) ] && echo "$RENT_OUT" | grep -q "closed $M voter records and 0 proposals"; } || { echo "$RENT_OUT" | tail -12; echo "FAIL: rent did not close all $M voter records (N=$N)"; exit 1; }
echo "  ok: rent closed all $M voter records and no proposal"

echo "== finish after the voting windows (execute in order, close, unwrap)"
echo "  (waiting for the end of the 45 s windows)"
OUT=""
for i in $(seq 1 40); do
  OUT="$(wd_yes finish 2>&1)" || true
  echo "$OUT" | grep -q "the voting is still running" || break
  sleep 3
done
echo "$OUT" | tail -8
echo "$OUT" | grep -q "DONE: the treasury is emptied" || { echo "FAIL: the finish step did not report DONE"; echo "$OUT" | tail -30; exit 1; }
echo "  ok: DONE"
EXEC="$(grep -c 'execute WD' "$GOV2_LOG" || true)"
[ "$EXEC" = "$N" ] || { echo "FAIL: execute appears $EXEC times, expected $N"; exit 1; }
echo "  ok: all $N pieces were executed in order"
grep -q "unwrap wSOL" "$GOV2_LOG" || { echo "FAIL: no unwrap in the journal"; exit 1; }

echo "== numbers"
EXPECT_LEFT="$(node -e 'const s=JSON.parse(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).done.series).map(BigInt);console.log((Number(1000000000n-s.reduce((a,b)=>a+b,0n))/1e9).toFixed(9))' "$GOV2_STATE")"
GOT_LEFT="$(wd status 2>&1 | sed -n 's/.*treasury [A-Za-z0-9]*: \([0-9.]*\) SOL (wSOL).*/\1/p' | head -1)"
[ "$GOT_LEFT" = "$EXPECT_LEFT" ] || { echo "FAIL: the treasury holds $GOT_LEFT SOL, expected $EXPECT_LEFT"; exit 1; }
echo "  ok: the treasury holds exactly $GOT_LEFT SOL (what the planned series leaves)"
SOL_AFTER="$(owner_sol)"
GAIN="$(node -e 'console.log((Number(process.argv[2])-Number(process.argv[1])).toFixed(6))' "$SOL_BEFORE" "$SOL_AFTER")"
WANT_GAIN="$(node -e 'console.log((1-Number(process.argv[1])).toFixed(6))' "$EXPECT_LEFT")"
node -e 'const g=Number(process.argv[1]),w=Number(process.argv[2]);process.exit(Math.abs(g-w)<0.001?0:1)' "$GAIN" "$WANT_GAIN" || { echo "FAIL: the owner gained $GAIN SOL, expected about $WANT_GAIN"; exit 1; }
echo "  ok: the owner wallet gained $GAIN SOL (expected about $WANT_GAIN: the treasury part, minus fees)"

echo "== again: nothing left to do"
expect "the owner has no wSOL account" wd_yes finish
CREATED2="$(grep -c 'create_proposal' "$GOV2_LOG" || true)"
EXEC2="$(grep -c 'execute WD' "$GOV2_LOG" || true)"
[ "$CREATED2" = "$N" ] && [ "$EXEC2" = "$N" ] || { echo "FAIL: the repeated finish changed something"; exit 1; }
echo "  ok: the repeated finish sent nothing new"
expect "closed 0 voter records and 0 proposals" wd_yes rent

echo
echo "ALL CHECKS PASSED (wind-down rehearsal: $N proposals, treasury 1 SOL -> $GOT_LEFT SOL left)"
