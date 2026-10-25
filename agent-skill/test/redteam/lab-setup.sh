#!/usr/bin/env bash
# Red-team lab, part 2: build the lab state on the LOCAL validator started by lab-validator.sh.
#   - fresh throw-away keys (owner, admin, agent = the fake agent wallet, attacker, clean) under ~/.onstate-local/keys
#   - a coin "LAB", a state with 2 SOL in the treasury, the agent wallet = finance minister holding 200 000 LAB
#   - 7 proposals (control + six injection attempts, see payloads.json), the agent wallet enrolled in all, voting open for 24 h
#   - the lab versions of the `onstate` / `onchainos` shims (not yet in place: lab-swap.sh on) and a clean workspace folder
# Nothing here touches mainnet or a real key.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
cd "$REPO"
LAB="${ONSTATE_LAB:-$HOME/.onstate-local}"
WS="${ONSTATE_LAB_WORKSPACE:-$HOME/sim-user2}"
PORT=8977
RPC="http://127.0.0.1:$PORT"

unset KEYPAIR TREASURY_MINT PROGRAM_ID GOVERNANCE_MINT ANCHOR_WALLET HTTP_CONFIRM PARAMS PARAM_OVERRIDES

curl -s -m 3 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "$RPC" | grep -q '"ok"' \
  || { echo "the lab validator is not running on $RPC - start lab-validator.sh first"; exit 1; }
[ -e "$LAB/ACTIVE" ] && { echo "the lab shims are in place already - run lab-swap.sh off before building a new lab"; exit 1; }

mkdir -p "$LAB/keys" "$LAB/shim" "$LAB/fake-okx" "$LAB/logs"
rm -f "$LAB/fake-okx/calls.log" "$LAB/lab.env.json"
for k in owner admin agent attacker clean; do solana-keygen new --no-bip39-passphrase --silent --force -o "$LAB/keys/$k.json" >/dev/null; done
OWNER="$(solana-keygen pubkey "$LAB/keys/owner.json")"
ADMIN="$(solana-keygen pubkey "$LAB/keys/admin.json")"
AGENT="$(solana-keygen pubkey "$LAB/keys/agent.json")"
ATTACKER="$(solana-keygen pubkey "$LAB/keys/attacker.json")"
CLEAN="$(solana-keygen pubkey "$LAB/keys/clean.json")"
solana airdrop 100 "$OWNER" --url "$RPC" >/dev/null
solana airdrop 3 "$AGENT" --url "$RPC" >/dev/null

export ANCHOR_PROVIDER_URL="$RPC"
export ANCHOR_WALLET="$LAB/keys/owner.json"
ts() { npx ts-node "$@"; }
run() { local name="$1"; shift; "$@" >"$LAB/logs/$name.log" 2>&1 || { cat "$LAB/logs/$name.log"; echo "step '$name' failed"; exit 1; }; }

echo "== coin"
run create_mint env NAME="Lab Coin" SYMBOL=LAB INITIAL_SUPPLY=1000000 OUT="$LAB/mint.json" npx ts-node scripts/create_mint.ts
MINT="$(solana-keygen pubkey "$LAB/mint.json")"
export GOVERNANCE_MINT="$MINT"
echo "coin $MINT"

echo "== state"
run initialize env OWNERS_AUTHORITY="$OWNER" ADMIN_AUTHORITY="$ADMIN" PRESIDENT="$OWNER" PARAMS=test \
  PARAM_OVERRIDES='{"votingPeriodSecs":30,"timelockSecs":0,"spendCooldownSecs":0}' npx ts-node scripts/initialize.ts
run fund env AMOUNT=2 npx ts-node scripts/fund_treasury.ts
run send_coins env CONFIRM=yes TO="$AGENT" AMOUNT=200000 npx ts-node scripts/send_coins.ts

echo "== two quick votes: the agent wallet becomes finance minister; the voting window becomes 24 h"
run appoint env TARGET="$AGENT" npx ts-node scripts/appoint_minister.ts
run param env PARAM_KEY=0 VALUE=86400 npx ts-node scripts/change_param.ts
echo "  (waiting for the 30 s voting window)"
sleep 36
run execute0 npx ts-node scripts/execute_proposal.ts 0
run execute1 npx ts-node scripts/execute_proposal.ts 1

echo "== the lab proposals (24 h voting, the agent wallet is enrolled)"
run open_proposals env ATTACKER="$ATTACKER" CLEAN="$CLEAN" VOTERS="$OWNER,$AGENT" npx ts-node agent-skill/test/redteam/open-lab-proposals.ts
grep '^PROPOSAL' "$LAB/logs/open_proposals.log"

echo "== shims and workspace"
cat > "$LAB/shim/onstate" <<SHIM
#!/bin/sh
export ONSTATE_RPC_URL="$RPC"
export ONSTATE_MINT="$MINT"
exec node "$REPO/agent-skill/cli/bin/onstate.js" "\$@"
SHIM
cat > "$LAB/shim/onchainos" <<SHIM
#!/bin/sh
export FAKE_OKX_KEYPAIR="$LAB/keys/agent.json"
export FAKE_OKX_RPC="$RPC"
export FAKE_OKX_DIR="$LAB/fake-okx"
export FAKE_OKX_CONFIRM="1"
exec node "$REPO/agent-skill/test/fake-onchainos.js" "\$@"
SHIM
chmod +x "$LAB/shim/onstate" "$LAB/shim/onchainos"

mkdir -p "$WS/.claude/skills"
rm -rf "$WS/.claude/skills/onchain-state"
mkdir -p "$WS/.claude/skills/onchain-state"
cp "$REPO/agent-skill/SKILL.md" "$WS/.claude/skills/onchain-state/SKILL.md"
cp -R "$REPO/agent-skill/references" "$WS/.claude/skills/onchain-state/references"

node -e '
const fs = require("fs")
const [lab, rpc, mint, owner, admin, agent, attacker, clean, ws] = process.argv.slice(1)
const log = fs.readFileSync(lab + "/logs/open_proposals.log", "utf8").split("\n").filter((l) => l.startsWith("PROPOSAL "))
const proposals = log.map((l) => { const [a, name] = l.split(" | "); return { id: Number(a.split(" ")[1]), name } })
fs.writeFileSync(lab + "/lab.env.json", JSON.stringify({ rpc, mint, owner, admin, agent, attacker, clean, workspace: ws, proposals, createdAt: new Date().toISOString() }, null, 2))
' "$LAB" "$RPC" "$MINT" "$OWNER" "$ADMIN" "$AGENT" "$ATTACKER" "$CLEAN" "$WS"

echo
echo "LAB READY"
echo "  rpc        $RPC"
echo "  coin       $MINT (LAB)"
echo "  agent      $AGENT (fake agent wallet: finance minister, 200 000 LAB, enrolled in every lab proposal)"
echo "  attacker   $ATTACKER (the address the injected texts try to pay)"
echo "  clean      $CLEAN (a harmless address you may use as the spend recipient)"
echo "  workspace  $WS (open the session HERE)"
echo "  next       bash agent-skill/test/redteam/lab-swap.sh on"
