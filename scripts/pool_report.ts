// READ-ONLY report: who owns the pool's liquidity and where the fees of the trades went. Sends nothing, needs no key.
// Run it BEFORE and AFTER a trade with REPORT_OUT=before.json / REPORT_PREV=before.json to see exactly where the fee of that trade went.
//
//   GOVERNANCE_MINT=<mint>  ANCHOR_PROVIDER_URL=<rpc>  ANCHOR_WALLET=<any key file, only to satisfy the loader>
//   LP_WALLET=<address>      (optional) mark the positions of this wallet
//   REPORT_OUT=file.json     (optional) save the numbers
//   REPORT_PREV=file.json    (optional) print the change since that earlier report
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { derivePositionNftAccount } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import * as fs from "fs";
import { GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, PROGRAM_ID } from "./lib/env";
import { loadPool, liquidityOf, unclaimedB, fmt, retry, short } from "./lib/pool";

async function main() {
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
  const { cp, pool, state, gov, quote } = await loadPool(conn);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config"), GOVERNANCE_MINT.toBuffer()], PROGRAM_ID)[0];
  const treasuryAta = getAssociatedTokenAddressSync(TREASURY_MINT, config, true, TREASURY_PROGRAM);
  const treasuryBal = (await retry(() => getAccount(conn, treasuryAta, "confirmed", TREASURY_PROGRAM))).amount;
  const vA = (await retry(() => conn.getTokenAccountBalance(state.tokenAVault))).value;
  const vB = (await retry(() => conn.getTokenAccountBalance(state.tokenBVault))).value;
  const all = (await retry(() => cp.getAllPositionsByPool(pool))).map((x: any) => ({ position: x.publicKey as PublicKey, positionState: x.account }));
  const lp = process.env.LP_WALLET ? new PublicKey(process.env.LP_WALLET) : null;
  const lpPositions = lp ? new Set((await retry(() => cp.getUserPositionByPool(pool, lp))).map((p) => p.position.toBase58())) : new Set<string>();
  const total = new BN(state.liquidity.toString());

  // the state's own position: the one whose NFT account is owned by the Config PDA
  const treasuryNftHolders = new Set<string>();
  for (const p of all) {
    const acc = await conn.getAccountInfo(derivePositionNftAccount(p.positionState.nftMint));
    if (acc && new PublicKey(acc.data.subarray(32, 64)).equals(config)) treasuryNftHolders.add(p.position.toBase58());
  }
  const rows = all.map((p) => {
    const liq = liquidityOf(p.positionState);
    return {
      address: p.position.toBase58(),
      label: treasuryNftHolders.has(p.position.toBase58()) ? "STATE TREASURY (locked forever)" : lpPositions.has(p.position.toBase58()) ? "your LP wallet (not locked)" : "other holder",
      sharePct: total.isZero() ? 0 : Number(liq.mul(new BN(1_000_000)).div(total)) / 10_000,
      unclaimedFeeSol: unclaimedB(state, p.positionState).toString(),
    };
  });
  const snap = {
    coinsInPool: vA.uiAmountString, solInPool: vB.uiAmountString,
    metaoraFeeUnclaimed: state.protocolBFee.toString(),
    treasuryWsol: treasuryBal.toString(),
    positions: rows,
  };
  console.log(`POOL ${pool.toBase58()}\n  coins ${snap.coinsInPool} | SOL ${snap.solInPool}`);
  console.log(`  fee waiting for Meteora (20% of all trade fees): ${fmt(snap.metaoraFeeUnclaimed, quote.decimals, 9)} SOL`);
  console.log(`  state treasury balance (already claimed):       ${fmt(snap.treasuryWsol, quote.decimals, 9)} SOL`);
  console.log("LIQUIDITY HOLDERS (the 80% of every fee is split by these shares):");
  for (const r of rows) console.log(`  ${short(r.address)}  ${r.sharePct.toFixed(2).padStart(7)} %  fee waiting to be claimed ${fmt(r.unclaimedFeeSol, quote.decimals, 9)} SOL   ${r.label}`);
  if (process.env.REPORT_OUT) { fs.writeFileSync(process.env.REPORT_OUT, JSON.stringify(snap, null, 1)); console.log(`(saved to ${process.env.REPORT_OUT})`); }
  if (process.env.REPORT_PREV) {
    const prev = JSON.parse(fs.readFileSync(process.env.REPORT_PREV, "utf8"));
    const d = (a: string, b: string) => (BigInt(a) - BigInt(b)).toString();
    console.log("\nCHANGE since the earlier report (in SOL) — this is where the money of the trades went:");
    console.log(`  SOL in the pool grew by:           ${(Number(snap.solInPool) - Number(prev.solInPool)).toFixed(9)}  (the buys + any liquidity added meanwhile; the fee is part of it until claimed)`);
    console.log(`  Meteora fee:                       ${fmt(d(snap.metaoraFeeUnclaimed, prev.metaoraFeeUnclaimed), quote.decimals, 9)}`);
    console.log(`  state treasury balance:            ${fmt(d(snap.treasuryWsol, prev.treasuryWsol), quote.decimals, 9)}  (grows when someone runs claim_pool_fees)`);
    for (const r of rows) {
      const old = prev.positions.find((x: any) => x.address === r.address);
      console.log(`  ${short(r.address)} fee waiting:         ${fmt(d(r.unclaimedFeeSol, old ? old.unclaimedFeeSol : "0"), quote.decimals, 9)}   ${r.label}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
