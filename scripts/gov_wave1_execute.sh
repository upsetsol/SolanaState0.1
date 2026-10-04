#!/usr/bin/env bash
# Executes the proposals of "wave 1" (see scripts/gov_wave1.sh) in the right order: FIRST the changes of the windows (so that the pause between spends is 0),
# then the spend, the milestone-fund deposit and the two appointments. Proposals that are not ready yet are reported and skipped — run the command again later.
#
#   CONFIRM=yes bash scripts/gov_wave1_execute.sh      (without CONFIRM=yes: only the status)
set -uo pipefail
cd "$(dirname "$0")/.."

RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${DEPLOYER_KEYPAIR:-$HOME/deployer-mainnet.json}"
MINT_FILE="${MINT_FILE:-$HOME/test2-mint-mainnet.json}"
STATE="${GOV_STATE:-$HOME/gov-wave1.state}"
PROGRAM_ID="3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD"
unset KEYPAIR TREASURY_MINT GOVERNANCE_MINT TARGET PARAM_KEY VALUE AMOUNT PROPOSAL_ID PARAMS 2>/dev/null || true
pubkey() { node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$1"; }
export ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" HTTP_CONFIRM=1 PROGRAM_ID GOVERNANCE_MINT="$(pubkey "$MINT_FILE")"
mask() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=***/g'; }
[ -f "$STATE" ] || { echo "no $STATE - run scripts/gov_wave1.sh first"; exit 1; }

echo "=== status of the proposals"
npx ts-node scripts/gov_status.ts 2>&1 | cut -c1-200
if [ "${CONFIRM:-}" != "yes" ]; then echo; echo "STATUS ONLY. To execute everything that is ready: CONFIRM=yes bash scripts/gov_wave1_execute.sh"; exit 0; fi

ok=0; wait=0
exec_one() { # exec_one KEY "title" [flag]
  local key="$1" title="$2" flag="${3:-}" id
  id="$(grep "^$key=" "$STATE" | head -1 | cut -d= -f2)"
  [ -n "$id" ] || { echo "--- $title: no such proposal in the state file"; return; }
  if grep -q "^DONE_$key=" "$STATE"; then echo "--- $title (#$id): already executed"; return; fi
  echo; echo "=== $title (#$id)"
  local out rc
  out="$(npx ts-node scripts/execute_proposal.ts "$id" $flag 2>&1)"; rc=$?
  if [ $rc -eq 0 ] && echo "$out" | grep -q "execute_proposal tx"; then
    echo "$out" | grep -E "execute_proposal tx|SPEND|recipient" | mask | cut -c1-200; echo "DONE_$key=1" >> "$STATE"; ok=$((ok+1))
  else
    local why; why="$(echo "$out" | grep -oE "Error Code: [A-Za-z]+" | head -1)"
    case "$why" in
      *ProposalStillActive*) echo "not ready: the voting is still running";;
      *TimelockNotElapsed*)  echo "not ready: the voting ended, the waiting time is not over";;
      *SpendCooldown*)       echo "not ready: the pause between money-moving proposals (run the command again after the pause)";;
      *QuorumNotReached*)    echo "!!! the turnout was too low";;
      *ProposalRejected*)    echo "!!! the proposal was rejected";;
      *ProposalExpired*)     echo "!!! the proposal expired";;
      *Paused*)              echo "!!! the pause is ON (scripts/set_pause.ts PAUSED=false)";;
      *) echo "!!! failed: ${why:-unknown}"; echo "$out" | mask | tail -3 | cut -c1-200;;
    esac
    wait=$((wait+1))
  fi
}
exec_one P_VOTING   "voting period"
exec_one P_TIMELOCK "timelock"
exec_one P_COOLDOWN "pause between spends"
exec_one P_FALLBACK "president's fallback"
exec_one P_SPEND    "spend 0.001 SOL" --spend
exec_one P_DEPOSIT  "milestone fund deposit" --milestone-deposit
exec_one P_FINANCE  "appoint the finance minister"
exec_one P_CULTURE  "appoint the culture minister"
echo
echo "executed now: $ok | not executed (not ready or a problem): $wait"
[ $wait -eq 0 ] && echo "WAVE 1 FULLY EXECUTED." || echo "Run the same command again later for the rest."
