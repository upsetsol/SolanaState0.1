#!/usr/bin/env bash
# Launch of a one-sided "dev = 0" coin ("Test 2"): coin -> state -> milestone fund -> pool (the WHOLE supply, no SOL) -> link -> revoke -> check.
# Pure glue around the existing scripts (each of them was rehearsed on devnet and on a local validator). Run it from anywhere:
#
#   NAME=test2 SYMBOL=TST URI=<link to the metadata json, may be empty> START_FDV=10 START_IN_SECS=600 CONFIRM=yes caffeinate -i bash scripts/launch_test2.sh
#
# Without CONFIRM=yes it only checks everything and prints the plan (nothing is sent). If a step fails (usually a network hiccup),
# run the SAME command again with FROM=<number of the failed step> in front; the steps that already happened are never repeated
# (a second run of create_mint / create_pool recognises its own earlier work and resumes).
# Step 6 (revoke) is IRREVERSIBLE: nobody can ever print more coins (and, with ALSO_METADATA=yes, change the name/logo).
#
# Optional: RPC_URL (default public mainnet)  DEPLOYER_KEYPAIR (default ~/deployer-mainnet.json)  INITIAL_SUPPLY (default 1000000000)
#           END_MULT (default 10000)  OWNERS_AUTHORITY / ADMIN_AUTHORITY / PRESIDENT (default = the deployer wallet)  ALSO_METADATA=yes|no
#           MINT_OUT / POOL_OUT (key and pool files, default ~/test2-mint-mainnet.json and ~/test2-pool-mainnet.json)
# On purpose it does NOT read ANCHOR_WALLET / ANCHOR_PROVIDER_URL / PROGRAM_ID from the shell: an old export from earlier sessions (the previous wallet,
# devnet, the old program) must never decide who launches or on which network.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC="${RPC_URL:-https://api.mainnet-beta.solana.com}"
WALLET="${DEPLOYER_KEYPAIR:-$HOME/deployer-mainnet.json}"
MINT_OUT="${MINT_OUT:-$HOME/test2-mint-mainnet.json}"
POOL_OUT="${POOL_OUT:-$HOME/test2-pool-mainnet.json}"
PROGRAM_ID="3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD"
: "${NAME:?set NAME (the coin name)}"
: "${SYMBOL:?set SYMBOL (the coin symbol)}"
: "${START_FDV:?set START_FDV (what the whole supply is worth at the start, in SOL)}"
URI="${URI:-}"
START_IN_SECS="${START_IN_SECS:-600}"
END_MULT="${END_MULT:-10000}"
SUPPLY="${INITIAL_SUPPLY:-1000000000}"
FROM="${FROM:-1}"

# the environment of the earlier sessions must not leak into the steps
unset KEYPAIR TREASURY_MINT FEE_BPS QUOTE_AMOUNT POOL POSITION_NFT WORKER DECIMALS GOVERNANCE_MINT TOKEN_AMOUNT PARAMS DEV PROGRAM_KEYPAIR BUFFER_KEYPAIR SO OUT 2>/dev/null || true

pubkey() { node -e 'const {Keypair}=require("@solana/web3.js");const fs=require("fs");console.log(Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).publicKey.toBase58())' "$1"; }
ME="$(pubkey "$WALLET")"
OWNER="${OWNERS_AUTHORITY:-$ME}"; ADMIN="${ADMIN_AUTHORITY:-$ME}"; PRES="${PRESIDENT:-$ME}"
if [ -z "$URI" ]; then ALSO_METADATA="${ALSO_METADATA:-no}"; else ALSO_METADATA="${ALSO_METADATA:-yes}"; fi
export ANCHOR_PROVIDER_URL="$RPC" ANCHOR_WALLET="$WALLET" HTTP_CONFIRM=1 PROGRAM_ID

mask() { sed -E 's/api-key=[A-Za-z0-9-]+/api-key=***/g'; }
echo "network          : $(echo "$RPC" | mask)"
echo "deployer wallet  : $ME"
echo "coin             : name \"$NAME\", symbol \"$SYMBOL\", supply $SUPPLY, metadata link: ${URI:-(none)}"
echo "start of trading : the whole supply is worth $START_FDV SOL at the start (first coin costs $START_FDV / $SUPPLY SOL), price range up to x$END_MULT; trading opens $START_IN_SECS s after the pool is created"
echo "roles            : owner $OWNER | admin $ADMIN | president $PRES"
echo "irreversible     : step 6 revokes the right to print coins$([ "$ALSO_METADATA" = "yes" ] && echo " AND the right to change the name/logo")"

# read-only checks: the program must be deployed here, Meteora must exist, the wallet needs ~0.08 SOL
node -e '
const {Connection,PublicKey}=require("@solana/web3.js");
const [rpc,prog,wallet,min]=process.argv.slice(1);
(async()=>{
  const c=new Connection(rpc,"confirmed");
  const p=await c.getAccountInfo(new PublicKey(prog));
  if(!p||!p.executable){console.error("the program "+prog+" is NOT deployed on this network - run the deploy first");process.exit(1);}
  const m=await c.getAccountInfo(new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG"));
  if(!m||!m.executable){console.error("Meteora DAMM v2 is not on this network");process.exit(1);}
  const b=await c.getBalance(new PublicKey(wallet));
  console.log("checks           : program "+prog.slice(0,6)+"... is deployed, Meteora is there, wallet balance "+(b/1e9).toFixed(4)+" SOL");
  if(b<Number(min)*1e9){console.error("not enough SOL on the wallet: need at least "+min);process.exit(1);}
})().catch(e=>{console.error(String(e.message).replace(/api-key=[A-Za-z0-9-]+/g,"api-key=***"));process.exit(1);});
' "$RPC" "$PROGRAM_ID" "$ME" 0.08

if [ "${CONFIRM:-}" != "yes" ]; then
  echo
  echo "DRY RUN - everything is checked, nothing was sent. Run the same command again with CONFIRM=yes in front to launch."
  exit 0
fi

step() { # step <n> <title> <command...>
  local n="$1" title="$2"; shift 2
  if [ "$n" -lt "$FROM" ]; then echo "--- step $n/7 ($title): skipped (FROM=$FROM)"; return 0; fi
  echo; echo "=== step $n/7: $title"
  if "$@"; then return 0; fi
  echo; echo "!!! step $n FAILED. Usually a network hiccup: run the same command again with FROM=$n in front (finished steps are not repeated)."
  exit 1
}

step 1 "create the coin (the whole supply is minted to the deployer wallet)" \
  env OUT="$MINT_OUT" NAME="$NAME" SYMBOL="$SYMBOL" URI="$URI" INITIAL_SUPPLY="$SUPPLY" npx ts-node scripts/create_mint.ts
GOV="$(pubkey "$MINT_OUT")"
echo "coin address     : $GOV"
step 2 "create the state (Config + treasury, production parameters)" \
  env GOVERNANCE_MINT="$GOV" OWNERS_AUTHORITY="$OWNER" ADMIN_AUTHORITY="$ADMIN" PRESIDENT="$PRES" PARAMS=prod npx ts-node scripts/initialize.ts
step 3 "create the milestone fund" \
  env GOVERNANCE_MINT="$GOV" npx ts-node scripts/setup_milestone_fund.ts
T4="$(date +%s)"
step 4 "create the pool: the WHOLE supply goes in, no SOL; the position is locked for ever and handed to the state" \
  env GOVERNANCE_MINT="$GOV" POOL_OUT="$POOL_OUT" SINGLE_SIDED=1 TOKEN_AMOUNT=all START_FDV="$START_FDV" START_IN_SECS="$START_IN_SECS" END_MULT="$END_MULT" npx ts-node scripts/create_pool.ts
step 5 "link the pool to the state" \
  env GOVERNANCE_MINT="$GOV" POOL_OUT="$POOL_OUT" npx ts-node scripts/register_pool.ts
step 6 "revoke the right to print coins (IRREVERSIBLE)" \
  env GOVERNANCE_MINT="$GOV" ALSO_METADATA="$ALSO_METADATA" CONFIRM=yes npx ts-node scripts/revoke_mint_authority.ts
step 7 "launch checklist (read-only; must say ALL PASS)" \
  env GOVERNANCE_MINT="$GOV" DEV="$ME" npx ts-node scripts/launch_check.ts

START_AT="$(date -r $((T4 + START_IN_SECS)) 2>/dev/null || date -d "@$((T4 + START_IN_SECS))" 2>/dev/null || echo "~$START_IN_SECS s after step 4")"
POOL_ADDR="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).pool)' "$POOL_OUT" 2>/dev/null || echo "?")"
echo
echo "LAUNCHED. coin $GOV | pool $POOL_ADDR"
echo "Trading opens at about $START_AT (the chain clock runs a few seconds behind the wall clock)."
echo "To buy the moment trading opens (start it a few minutes BEFORE the opening: it waits and buys by itself; keep ~0.05 SOL for fees):"
echo "  cd $(pwd) && AMOUNT=<SOL> CONFIRM=yes caffeinate -i npx ts-node scripts/buy_when_open.ts"
