#!/usr/bin/env bash
# "AGENT VOTE TEST" on the live Test 2 state: one step per run (see the header of scripts/agent_vote_test.ts).
#
#   [CONFIRM=yes] bash scripts/agent_vote_test.sh <status|send|open|finish>
#
# Without CONFIRM=yes a step only prints its plan (reads the chain, sends nothing). Every step is safe to run again.
# Optional: RPC_URL, DEPLOYER_KEYPAIR (default ~/deployer-mainnet.json), MINT_FILE (default ~/test2-mint-mainnet.json),
#           AGENT_WALLET (default: the OKX agent wallet Bb5Z...), AGENT_COINS (default 1000000), OWNER_KEEP_COINS (default 10000000).
#           Old ANCHOR_* / GOVERNANCE_MINT / PROGRAM_ID exports of the shell are ignored on purpose.
set -uo pipefail
cd "$(dirname "$0")/.."

STEP="${1:-status}"
RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${DEPLOYER_KEYPAIR:-$HOME/deployer-mainnet.json}"
MINT_FILE="${MINT_FILE:-$HOME/test2-mint-mainnet.json}"
PROGRAM_ID="3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD"
unset KEYPAIR TREASURY_MINT GOVERNANCE_MINT TARGET PARAM_KEY VALUE AMOUNT PROPOSAL_ID PARAMS PARAM_OVERRIDES POOL POSITION_NFT 2>/dev/null || true

pubkey() { node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$1"; }
mask() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=***/g'; }
[ -f "$WALLET" ] || { echo "no wallet file $WALLET"; exit 1; }
[ -f "$MINT_FILE" ] || { echo "no coin key file $MINT_FILE"; exit 1; }
GOV="$(pubkey "$MINT_FILE")"
export ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" HTTP_CONFIRM=1 PROGRAM_ID GOVERNANCE_MINT="$GOV"
export GOV2_STATE="${GOV2_STATE:-$HOME/agent-vote-test.state.json}" GOV2_LOG="${GOV2_LOG:-$HOME/agent-vote-test.log}"
echo "network : $(echo "$RPC" | mask)"
echo "coin    : $GOV | owner wallet $(pubkey "$WALLET") | step: $STEP$([ "${CONFIRM:-}" = "yes" ] && echo " (CONFIRM=yes: real transactions)" || echo " (plan only)")"
exec npx ts-node scripts/agent_vote_test.ts "$STEP"
