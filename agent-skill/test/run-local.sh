#!/usr/bin/env bash
# Local end-to-end test of the `onstate` CLI with a FAKE `baw` (no Binance, no real money).
#
#   bash agent-skill/test/run-local.sh            # fast run (~5 min)
#   E2E_SLOW=1 bash agent-skill/test/run-local.sh # also checks what happens when the preview's blockhash goes stale (+90 s)
#
# What it does: starts a local validator with our program (target/deploy/onchain_state_solana.so),
# creates a small state (coin, treasury with 1 SOL, a vote that appoints the "agent" wallet finance minister),
# opens one more proposal, then runs agent-skill/test/e2e.js against the CLI.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"

unset KEYPAIR TREASURY_MINT PROGRAM_ID GOVERNANCE_MINT ANCHOR_WALLET HTTP_CONFIRM PARAMS PARAM_OVERRIDES

WORK="${E2E_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/onstate-e2e.XXXXXX")}"
mkdir -p "$WORK/bin" "$WORK/home"
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

for k in owner admin agent outsider; do solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/$k.json" >/dev/null; done
OWNER="$(solana-keygen pubkey "$WORK/owner.json")"
ADMIN="$(solana-keygen pubkey "$WORK/admin.json")"
AGENT="$(solana-keygen pubkey "$WORK/agent.json")"
OUTSIDER="$(solana-keygen pubkey "$WORK/outsider.json")"
solana airdrop 100 "$OWNER" --url "$RPC" >/dev/null
solana airdrop 1 "$AGENT" --url "$RPC" >/dev/null
solana airdrop 1 "$OUTSIDER" --url "$RPC" >/dev/null

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$WORK/owner.json"
ts() { npx ts-node "$@"; }

echo "== coin"
NAME="Local Test" SYMBOL=LTS INITIAL_SUPPLY=1000000 OUT="$WORK/mint.json" ts scripts/create_mint.ts >"$WORK/create_mint.log" 2>&1 || { cat "$WORK/create_mint.log"; exit 1; }
MINT="$(solana-keygen pubkey "$WORK/mint.json")"
export GOVERNANCE_MINT="$MINT"
echo "coin $MINT"

echo "== state"
OWNERS_AUTHORITY="$OWNER" ADMIN_AUTHORITY="$ADMIN" PRESIDENT="$OWNER" PARAMS=test \
  PARAM_OVERRIDES='{"votingPeriodSecs":45,"timelockSecs":0,"spendCooldownSecs":0}' ts scripts/initialize.ts >"$WORK/initialize.log" 2>&1 || { cat "$WORK/initialize.log"; exit 1; }
AMOUNT=1 ts scripts/fund_treasury.ts >"$WORK/fund.log" 2>&1 || { cat "$WORK/fund.log"; exit 1; }
CONFIRM=yes TO="$AGENT" AMOUNT=200000 ts scripts/send_coins.ts >"$WORK/send.log" 2>&1 || { cat "$WORK/send.log"; exit 1; }

echo "== appoint the agent wallet as finance minister (vote, 45 s)"
TARGET="$AGENT" ts scripts/appoint_minister.ts >"$WORK/appoint.log" 2>&1 || { cat "$WORK/appoint.log"; exit 1; }
sleep 48
ts scripts/execute_proposal.ts 0 >"$WORK/execute0.log" 2>&1 || { cat "$WORK/execute0.log"; exit 1; }

echo "== open a second proposal for the vote test"
VOTE_ID="$(VOTERS="$OWNER,$AGENT" ts agent-skill/test/open-proposal.ts 2>"$WORK/open.err" | sed -n 's/^PROPOSAL_ID=//p')"
[ -n "$VOTE_ID" ] || { cat "$WORK/open.err"; echo "could not open the proposal"; exit 1; }
echo "proposal $VOTE_ID is open for voting"

ln -sf "$HERE/fake-baw.js" "$WORK/bin/baw"
chmod +x "$HERE/fake-baw.js"

echo "== CLI tests"
E2E_WORK="$WORK" E2E_RPC="$RPC" E2E_MINT="$MINT" E2E_OWNER="$OWNER" E2E_AGENT="$AGENT" E2E_OUTSIDER="$OUTSIDER" E2E_VOTE_PROPOSAL="$VOTE_ID" \
  node "$HERE/e2e.js"

echo "== appoint wrapper (scripts/appoint_agent.sh) on the same local state"
expect() { # expect "<text>" command...   runs the command, prints it on failure
  local want="$1"; shift
  local got; got="$("$@" 2>&1)" || true
  echo "$got" | grep -q -- "$want" || { echo "$got"; echo "FAIL: expected \"$want\""; exit 1; }
  echo "  ok: $want"
}
appoint() { RPC_URL="$RPC" DEPLOYER_KEYPAIR="$WORK/owner.json" MINT_FILE="$WORK/mint.json" bash scripts/appoint_agent.sh "$@"; }
appoint_yes() { CONFIRM=yes appoint "$@"; }
expect "DRY RUN" appoint create culture "$OUTSIDER"
expect "DONE: proposal" appoint_yes create culture "$OUTSIDER"
expect "no duplicate is created" appoint_yes create culture "$OUTSIDER"
expect "a role must be held by a distinct address" appoint_yes create culture "$AGENT"   # the agent already holds the finance role
echo "  (waiting for the 45 s voting window)"
expect "is now the culture minister" appoint_yes execute culture "$OUTSIDER"
expect "ALREADY DONE" appoint_yes execute culture "$OUTSIDER"
ROLE="$(ONSTATE_RPC_URL="$RPC" ONSTATE_MINT="$MINT" node "$HERE/../cli/bin/onstate.js" status | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).roles.cultureMinister))')"
[ "$ROLE" = "$OUTSIDER" ] || { echo "FAIL: culture minister is $ROLE, expected $OUTSIDER"; exit 1; }
echo "  ok: onstate status shows the new culture minister"

echo "== OKX signer (fake onchainos): the wallet that was just appointed culture minister acts as the OKX wallet"
E2E_WORK="$WORK" E2E_RPC="$RPC" E2E_MINT="$MINT" E2E_OWNER="$OWNER" E2E_AGENT="$AGENT" E2E_OUTSIDER="$OUTSIDER" \
  node "$HERE/e2e-okx.js"
echo "ALL LOCAL CHECKS PASSED"
