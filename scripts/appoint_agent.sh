#!/usr/bin/env bash
# Appoint a finance or culture minister on the live Test 2 state by the OWNER's vote (details: scripts/appoint_agent.ts).
#
#   CONFIRM=yes bash scripts/appoint_agent.sh create  culture <wallet address>
#   CONFIRM=yes bash scripts/appoint_agent.sh execute culture <wallet address>     (after the 5-minute voting window)
#
# Without CONFIRM=yes: checks and plan only. Safe to run again (never creates a duplicate proposal).
# Optional: RPC_URL, DEPLOYER_KEYPAIR, MINT_FILE (defaults as in the wave scripts). Old ANCHOR_* / GOVERNANCE_MINT /
# PROGRAM_ID exports of the shell are ignored on purpose.
set -uo pipefail
cd "$(dirname "$0")/.."

RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${DEPLOYER_KEYPAIR:-$HOME/deployer-mainnet.json}"
MINT_FILE="${MINT_FILE:-$HOME/test2-mint-mainnet.json}"
PROGRAM_ID="3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD"
unset KEYPAIR TREASURY_MINT GOVERNANCE_MINT TARGET PARAM_KEY VALUE AMOUNT PROPOSAL_ID PARAMS PARAM_OVERRIDES POOL POSITION_NFT 2>/dev/null || true

[ $# -eq 3 ] || { echo "usage: CONFIRM=yes bash scripts/appoint_agent.sh <create|execute> <finance|culture> <wallet address>"; exit 2; }
pubkey() { node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$1"; }
GOV="$(pubkey "$MINT_FILE")" || { echo "cannot read the coin key file $MINT_FILE"; exit 1; }
export ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" HTTP_CONFIRM=1 PROGRAM_ID GOVERNANCE_MINT="$GOV"
mask() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=***/g'; }
echo "network  : $(echo "$RPC" | mask)"

set -o pipefail
npx ts-node scripts/appoint_agent.ts "$@" 2>&1 | mask
exit "${PIPESTATUS[0]}"
