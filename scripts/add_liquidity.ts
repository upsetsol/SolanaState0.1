// Add liquidity to the state's Meteora pool as a SEPARATE, NOT locked position (it can be taken back with remove_liquidity.ts).
// The state's own position (Config PDA, locked forever) is not touched. The fee share of the new position goes to whoever owns it.
//
//   GOVERNANCE_MINT=<mint>   TREASURY_MINT=<mint> (optional, default wSOL)
//   KEYPAIR=~/lp-wallet.json   the wallet that provides the liquidity: it needs the SOL AND the coins (see send_coins.ts)
//   SOL_AMOUNT=0.5             how much SOL (treasury asset) to put in; the matching amount of coins is computed at the current price
//   SLIPPAGE=1                 percent (optional)
//   CONFIRM=yes                without it the script only PRINTS the plan (dry run)
import { Keypair } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import { getProvider, parseUnits, GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, TOKEN_PROGRAM, ATA_PROGRAM } from "./lib/env";
import { loadPool, liquidityOf, fmt, retry, requireConfirm, short } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const { cp, pool, state, gov, quote } = await loadPool(conn);
  const solIn = new BN(parseUnits(process.env.SOL_AMOUNT ?? "0.5", quote.decimals).toString());
  const slip = Number(process.env.SLIPPAGE ?? "1");
  const mul = (x: BN) => x.muln(Math.round((100 + slip) * 100)).divn(10000).addn(1);

  const q: any = cp.getDepositQuote({
    inAmount: solIn, isTokenA: false, minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, sqrtPrice: state.sqrtPrice,
    collectFeeMode: state.collectFeeMode, tokenAAmount: new BN(0), tokenBAmount: new BN(0), liquidity: state.liquidity,
  });
  const coinsNeeded: BN = q.outputAmount;
  const total = new BN(state.liquidity.toString());
  const share = Number(q.liquidityDelta.mul(new BN(1_000_000)).div(q.liquidityDelta.add(total))) / 10_000;

  const coinAta = getAssociatedTokenAddressSync(GOVERNANCE_MINT, me, false, TOKEN_PROGRAM, ATA_PROGRAM);
  const coinBal = await retry(() => getAccount(conn, coinAta, "confirmed", TOKEN_PROGRAM)).then((a) => a.amount, () => 0n);
  const solBal = BigInt(await retry(() => conn.getBalance(me, "confirmed")));

  console.log("wallet providing liquidity :", me.toBase58());
  console.log("pool                       :", pool.toBase58());
  console.log(`you put in                 : ${fmt(solIn, quote.decimals)} SOL + ${fmt(coinsNeeded, gov.decimals, 2)} coins (at the current price; up to ${slip}% more allowed)`);
  console.log(`your share of the pool     : ${share.toFixed(2)} %   (the state's locked position keeps ${(100 - share).toFixed(2)} %)`);
  console.log(`wallet has                 : ${fmt(solBal, 9)} SOL, ${fmt(coinBal, gov.decimals, 2)} coins`);
  const needSol = BigInt(mul(solIn).toString()) + 20_000_000n; // + rent of the position, fees
  if (solBal < needSol) throw new Error(`not enough SOL: need about ${fmt(needSol, 9)} (deposit + ~0.02 for the position account and fees)`);
  if (coinBal < BigInt(mul(coinsNeeded).toString())) throw new Error(`not enough coins: need about ${fmt(mul(coinsNeeded), gov.decimals, 2)}; send them with scripts/send_coins.ts`);
  requireConfirm("add the liquidity");

  const positionNft = Keypair.generate();
  const maxA = mul(coinsNeeded), maxB = mul(solIn);
  const tx = await cp.createPositionAndAddLiquidity({
    owner: me, pool, positionNft: positionNft.publicKey, liquidityDelta: q.liquidityDelta,
    maxAmountTokenA: maxA, maxAmountTokenB: maxB, tokenAAmountThreshold: maxA, tokenBAmountThreshold: maxB,
    tokenAMint: GOVERNANCE_MINT, tokenBMint: TREASURY_MINT, tokenAProgram: TOKEN_PROGRAM, tokenBProgram: TREASURY_PROGRAM,
  } as any);
  const sig = await provider.sendAndConfirm(tx, [positionNft]);
  console.log(`\nDONE. Position NFT ${positionNft.publicKey.toBase58()} (${short(positionNft.publicKey)}), tx ${sig}`);
  const mine = await retry(() => cp.getUserPositionByPool(pool, me));
  for (const p of mine) console.log(`  your position ${short(p.position)}: liquidity ${liquidityOf(p.positionState).toString().slice(0, 8)}…`);
  console.log("Take it back any time:  KEYPAIR=… GOVERNANCE_MINT=… CONFIRM=yes npx ts-node scripts/remove_liquidity.ts");
}
main().catch((e) => { console.error(e); process.exit(1); });
