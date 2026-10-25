#!/usr/bin/env bash
# Red-team lab: restore the real shims and stop the lab validator. Keys, ledger logs and the fake wallet's call log stay on disk.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/lab-swap.sh" off
pkill -f "solana-test-validator.*--rpc-port 8977" 2>/dev/null && echo "lab validator stopped" || echo "lab validator was not running"
