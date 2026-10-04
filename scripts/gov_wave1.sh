#!/usr/bin/env bash
# "WAVE 1" of the governance checks on the live Test 2 state. Creates EIGHT proposals in one go — each one is: create + the owner's snapshot + open the voting + vote "for":
#   1-4  shorten the windows: voting 5 minutes (contract minimum), timelock 0, pause between spends 0, president's fallback 1 hour
#   5    spend 0.001 SOL from the treasury to the own wallet
#   6-7  appoint a finance minister and a culture minister (two new helper wallets are created for them)
#   8    top up the milestone fund by 0.005 SOL
# All of them finish voting at the same moment (1 day) and become executable after the timelock (1 more day): see scripts/gov_status.ts, then scripts/gov_wave1_execute.sh.
#
#   CONFIRM=yes bash scripts/gov_wave1.sh          (without CONFIRM=yes: checks and plan only)
# Safe to run again: proposals that were already created are remembered in ~/gov-wave1.state and not repeated.
# Optional: RPC_URL, DEPLOYER_KEYPAIR, MINT_FILE (default ~/test2-mint-mainnet.json). Old ANCHOR_* / GOVERNANCE_MINT / PROGRAM_ID exports of the shell are ignored on purpose.
set -uo pipefail
cd "$(dirname "$0")/.."

RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${DEPLOYER_KEYPAIR:-$HOME/deployer-mainnet.json}"
MINT_FILE="${MINT_FILE:-$HOME/test2-mint-mainnet.json}"
STATE="${GOV_STATE:-$HOME/gov-wave1.state}"
WALLETS="${GOV_WALLETS:-$HOME/gov-test-wallets}"
PROGRAM_ID="3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD"
SHORT_VOTE="${SHORT_VOTE:-300}"
unset KEYPAIR TREASURY_MINT GOVERNANCE_MINT TARGET PARAM_KEY VALUE AMOUNT PROPOSAL_ID PARAMS POOL POSITION_NFT 2>/dev/null || true

pubkey() { node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$1"; }
GOV="$(pubkey "$MINT_FILE")"
ME="$(pubkey "$WALLET")"
export ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" HTTP_CONFIRM=1 PROGRAM_ID GOVERNANCE_MINT="$GOV"
mask() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=***/g'; }
echo "network : $(echo "$RPC" | mask)"
echo "state   : coin $GOV | your wallet (owner, president, the only voter) $ME"

# read-only checks
node -e '
const {Connection,PublicKey}=require("@solana/web3.js");
const {getAccount,getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID}=require("@solana/spl-token");
const [rpc,prog,gov,me]=process.argv.slice(1);
(async()=>{
  const c=new Connection(rpc,"confirmed");
  const cfg=PublicKey.findProgramAddressSync([Buffer.from("config"),new PublicKey(gov).toBuffer()],new PublicKey(prog))[0];
  if(!(await c.getAccountInfo(cfg))){console.error("no state (Config) for this coin on this network");process.exit(1);}
  const bal=await c.getBalance(new PublicKey(me));
  const coins=await getAccount(c,getAssociatedTokenAddressSync(new PublicKey(gov),new PublicKey(me),false,TOKEN_2022_PROGRAM_ID),"confirmed",TOKEN_2022_PROGRAM_ID).then(a=>Number(a.amount)/1e9,()=>0);
  console.log("checks  : state exists, wallet "+(bal/1e9).toFixed(4)+" SOL, "+coins.toLocaleString("en-US")+" coins");
  if(bal<0.06e9){console.error("not enough SOL: each proposal costs ~0.004 SOL of refundable deposits; need at least 0.06 SOL");process.exit(1);}
  if(coins<=0){console.error("this wallet holds no coins - it cannot create proposals");process.exit(1);}
})().catch(e=>{console.error(String(e.message).replace(/api-key=[A-Za-z0-9-]+/g,"api-key=***"));process.exit(1);});
' "$RPC" "$PROGRAM_ID" "$GOV" "$ME" || exit 1

mkdir -p "$WALLETS" && chmod 700 "$WALLETS"
for w in finance-minister culture-minister; do
  if [ ! -f "$WALLETS/$w.json" ]; then
    node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify(Array.from(Keypair.generate().secretKey)),{mode:0o600,flag:"wx"})' "$WALLETS/$w.json"
    echo "created helper wallet: $WALLETS/$w.json"
  fi
done
FIN="$(pubkey "$WALLETS/finance-minister.json")"; CUL="$(pubkey "$WALLETS/culture-minister.json")"
echo "helpers : finance minister -> $FIN | culture minister -> $CUL"

if [ "${CONFIRM:-}" != "yes" ]; then
  echo
  echo "DRY RUN — nothing was sent. Run the same command again with CONFIRM=yes in front to create the 8 proposals."
  exit 0
fi

FAILED=0
count() { COUNT_ONLY=1 npx ts-node scripts/gov_status.ts 2>/dev/null | tail -1; }
set_state() { # set_state KEY VALUE  (replaces the line of KEY)
  touch "$STATE"; grep -v "^$1=" "$STATE" > "$STATE.tmp" 2>/dev/null; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"
}
run_prop() { # run_prop KEY TYPE PARAM_KEY "title" command...
  local key="$1" type="$2" pk="$3" title="$4"; shift 4
  local cur; cur="$(grep "^$key=" "$STATE" 2>/dev/null | head -1 | cut -d= -f2)"
  if [[ "$cur" =~ ^[0-9]+$ ]]; then echo "--- $title: already created (#$cur)"; return; fi
  local c; c="$(count)"; [[ "$c" =~ ^[0-9]+$ ]] || { echo "!!! cannot read the number of proposals (network?) - run the same command again"; FAILED=1; return; }
  if [[ "$cur" == PENDING:* ]]; then
    local pid="${cur#PENDING:}"
    if [ "$c" -gt "$pid" ]; then   # the proposal WAS created on chain earlier but not completed: complete it, do not create a duplicate
      echo; echo "=== $title: finishing the proposal #$pid that was created earlier but not completed"
      if env PROPOSAL_ID="$pid" EXPECT_TYPE="$type" EXPECT_PARAM_KEY="$pk" npx ts-node scripts/finish_proposal.ts 2>&1 | mask | cut -c1-200 | tee /dev/stderr | grep -q "^DONE"; then set_state "$key" "$pid"; else echo "!!! FAILED to finish #$pid - run the same command again"; FAILED=1; fi
      return
    fi
  fi
  set_state "$key" "PENDING:$c"      # the id this proposal will get; remembered BEFORE sending, so that a dropped connection cannot lead to a duplicate
  echo; echo "=== $title"
  local out rc id
  out="$("$@" 2>&1)"; rc=$?
  echo "$out" | grep -E "create_proposal|snapshot|Error|error" | mask | cut -c1-220
  id="$(echo "$out" | grep -o "id: [0-9]*" | head -1 | grep -o "[0-9]*")"
  if [ $rc -eq 0 ] && [ -n "$id" ]; then set_state "$key" "$id"; else echo "!!! FAILED: $title — run the same command again (it will finish this proposal, not repeat it)"; FAILED=1; fi
}
run_prop P_VOTING   4 0  "1/8 voting period -> $SHORT_VOTE s"     env PARAM_KEY=0  VALUE=$SHORT_VOTE npx ts-node scripts/change_param.ts
run_prop P_TIMELOCK 4 9  "2/8 timelock -> 0"                      env PARAM_KEY=9  VALUE=0           npx ts-node scripts/change_param.ts
run_prop P_COOLDOWN 4 13 "3/8 pause between spends -> 0"          env PARAM_KEY=13 VALUE=0           npx ts-node scripts/change_param.ts
run_prop P_FALLBACK 4 14 "4/8 president's fallback -> 3600 s"     env PARAM_KEY=14 VALUE=3600        npx ts-node scripts/change_param.ts
run_prop P_SPEND    0 "" "5/8 spend 0.001 SOL to the own wallet"  env AMOUNT=1000000                 npx ts-node scripts/propose_and_vote.ts
run_prop P_FINANCE  2 "" "6/8 appoint the finance minister"       env TARGET="$FIN"                  npx ts-node scripts/appoint_minister.ts
run_prop P_CULTURE  3 "" "7/8 appoint the culture minister"       env TARGET="$CUL"                  npx ts-node scripts/appoint_culture_minister.ts
run_prop P_DEPOSIT  6 "" "8/8 top up the milestone fund 0.005 SOL" env AMOUNT=5000000                npx ts-node scripts/deposit_to_milestone_fund.ts

echo
echo "=== state of all proposals (read-only)"
npx ts-node scripts/gov_status.ts 2>&1 | cut -c1-200
echo
if [ $FAILED -eq 0 ]; then
  echo "WAVE 1 CREATED. The votes are open. They end and the proposals become executable at the times printed above (about 2 days from now)."
  echo "Then:  bash scripts/gov_wave1_execute.sh   (it executes them in the right order: first the windows, then the rest)"
else
  echo "Some proposals failed - run the same command again."
  exit 1
fi
