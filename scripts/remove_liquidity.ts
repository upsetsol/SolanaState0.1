// Take back ALL liquidity (and the earned fees) from the NOT locked positions of KEYPAIR in the state's pool, and close them.
// Locked positions (the state's own) are skipped.
//
//   GOVERNANCE_MINT=<mint>  KEYPAIR=~/lp-wallet.json  CONFIRM=yes (without it: dry run)
import BN from "bn.js";
import { getProvider } from "./lib/env";
import { loadPool, liquidityOf, unclaimedB, fmt, retry, requireConfirm, short } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const { cp, pool, state, gov, quote } = await loadPool(conn);
  const mine = (await retry(() => cp.getUserPositionByPool(pool, me))).filter((p) => p.positionState.permanentLockedLiquidity.toString() === "0");
  if (!mine.length) { console.log("this wallet has no removable positions in the pool"); return; }
  for (const p of mine) {
    const wq: any = cp.getWithdrawQuote({ liquidityDelta: liquidityOf(p.positionState), minSqrtPrice: state.sqrtMinPrice, maxSqrtPrice: state.sqrtMaxPrice, sqrtPrice: state.sqrtPrice, collectFeeMode: state.collectFeeMode } as any);
    console.log(`position ${short(p.position)}: you get back about ${fmt(wq.outAmountA, gov.decimals, 2)} coins + ${fmt(wq.outAmountB, quote.decimals)} SOL, plus unclaimed fee ${fmt(unclaimedB(state, p.positionState), quote.decimals)} SOL`);
  }
  requireConfirm("remove the liquidity and close the positions");
  const slot = await conn.getSlot();
  const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  for (const p of mine) {
    const st: any = await retry(() => cp.fetchPoolState(pool));
    const tx = await cp.removeAllLiquidityAndClosePosition({
      owner: me, position: p.position, positionNftAccount: p.positionNftAccount, poolState: st, positionState: p.positionState,
      tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), vestings: [], currentPoint: new BN(now),
    } as any);
    const sig = await provider.sendAndConfirm(tx);
    console.log(`closed ${short(p.position)} — tx ${sig}`);
  }
  console.log("DONE. Coins and SOL are back on the wallet.");
}
main().catch((e) => { console.error(e); process.exit(1); });
