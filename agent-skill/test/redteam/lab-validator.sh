#!/usr/bin/env bash
# Red-team lab, part 1: a LOCAL validator on port 8977 with our program. Run it in the background and leave it running.
# Nothing here touches mainnet or any real key.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
LAB="${ONSTATE_LAB:-$HOME/.onstate-local}"
PORT=8977
SO="$REPO/target/deploy/onchain_state_solana.so"
[ -f "$SO" ] || { echo "missing $SO - run 'anchor build' first"; exit 1; }
PROGRAM_ID="$(node -e "console.log(require('$REPO/idl/onchain_state_solana.json').address)")"
if (echo > "/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then echo "port $PORT is already in use - is the lab validator already running?"; exit 1; fi
mkdir -p "$LAB"
exec solana-test-validator --reset --quiet --ledger "$LAB/ledger" --rpc-port "$PORT" --faucet-port 9977 \
  --bpf-program "$PROGRAM_ID" "$SO" --limit-ledger-size 500000000
