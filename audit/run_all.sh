#!/usr/bin/env bash
# Runs every abuse test against a LOCAL validator (start it first, see audit/README.md) and prints one summary.
set -u
export ANCHOR_PROVIDER_URL=${ANCHOR_PROVIDER_URL:-http://127.0.0.1:8899}
cd "$(dirname "$0")/.."
for t in a1_access a1b_arbitrary_cpi a2_voting_trading a2b_hopping_scale a2c_lp_quorum a3_milestones a4_init a5_competing_pool a6_admin_pause a7_rogue_owner a8_position_delegate a9_cleanup_payroll; do
  echo "################ $t"
  npx ts-node audit/$t.ts 2>&1 | grep -E "^(===|🛡️|⚠️|✅|ℹ️|❌)" 
done
