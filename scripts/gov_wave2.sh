#!/usr/bin/env bash
# "WAVE 2" of the governance checks on the live Test 2 state: one step per run (see the header of scripts/gov_wave2.ts).
#
#   [CONFIRM=yes] bash scripts/gov_wave2.sh <prep|money|votes|execute|cleanup|status|report>
#   report = the list of transactions behind EVERY vote of the state (read-only; OUT=<file.md> also saves it, FROM=<first proposal id>)
#
# Without CONFIRM=yes a step only prints its plan (reads the chain, sends nothing). Every step is safe to run again.
# Optional: RPC_URL, DEPLOYER_KEYPAIR (default ~/deployer-mainnet.json), MINT_FILE (default ~/test2-mint-mainnet.json), GOV_WALLETS (default ~/gov-test-wallets),
#           GOV2_STATE (~/gov-wave2.state.json), GOV2_LOG (~/gov-wave2.log). Old ANCHOR_* / GOVERNANCE_MINT / PROGRAM_ID exports of the shell are ignored on purpose.
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
echo "network : $(echo "$RPC" | mask)"
echo "coin    : $GOV | owner wallet $(pubkey "$WALLET") | step: $STEP$([ "${CONFIRM:-}" = "yes" ] && echo " (CONFIRM=yes: real transactions)" || echo " (plan only)")"
if [ "$STEP" = "report" ]; then exec npx ts-node scripts/proposals_report.ts; fi
exec npx ts-node scripts/gov_wave2.ts "$STEP"
