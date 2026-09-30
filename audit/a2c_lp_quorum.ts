// A2c — the quorum base could be moved WITHOUT trading in v4: a stranger simply adds (or removes) his own liquidity in our
// pool. Coins that sit in the pool vault leave the voting base, and adding/removing liquidity charges no trading fee.
// v4.1 freezes the base at open_voting, so a liquidity move AFTER the start of the voting no longer matters.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a2c_lp_quorum.ts
import { Keypair } from "@solana/web3.js";
import { CollectFeeMode } from "@meteora-ag/cp-amm-sdk";
import { makeWorld, group, record, recordFixed, attempt, BN, TP, TPT, NATIVE_MINT, COIN, SOL, finish, sendSigned, errText } from "./lib";

const coins = (n: bigint) => n / COIN;

async function main() {
  group("A2c quorum moved by add/remove liquidity (no trading fee)");
  const QBPS = 300n;
  const w = await makeWorld({ name: "a2c", params: { cooldown: 0, vote: 14, timelock: 6, quorumSpendBps: Number(QBPS) } });
  await w.seedTreasury(5n * SOL);
  await w.withPool(300_000_000n, 30n * SOL);
  const baseNow = async () => (await w.supplyNow()) - (await w.bal(await w.poolVaultA()));
  const base0 = await baseNow();
  const quorum = (base0 * QBPS) / 10_000n;
  const weight = coins(quorum) - 50_000n; // 0.05M coins SHORT of quorum
  const Dq = await w.holder(weight, 5);
  const S = await w.holder(10_000_000n, 100); // a stranger with some coins and SOL
  const p = await w.propose(0, w.me, 1000n, 0, "quorum-by-liquidity test");
  await w.snapshot(p.id, p.pPda, Dq.publicKey);
  await w.openVoting(p.id); // the quorum base is frozen here
  await w.vote(Dq, p.id, p.pPda, true);
  await w.waitExecutable(p.pPda);
  const before = await attempt(() => w.execute(p.id, { recipient: w.tAta(w.me) }));
  const shortBefore = !before.ok && /QuorumNotReached/.test(before.err);

  // the stranger becomes a liquidity provider of OUR pool with 3M coins (+ matching SOL)
  const cp = w.cpAmm;
  const st: any = await cp.fetchPoolState(w.poolAddr);
  const inA = new BN((3_000_000n * COIN).toString());
  const dq: any = (cp as any).getDepositQuote({
    inAmount: inA, isTokenA: true, minSqrtPrice: st.sqrtMinPrice, maxSqrtPrice: st.sqrtMaxPrice, sqrtPrice: st.sqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB, tokenAAmount: st.tokenAAmount, tokenBAmount: st.tokenBAmount, liquidity: st.liquidity,
  });
  const nft = Keypair.generate();
  const v0 = await w.solOf(S.publicKey);
  const c0 = await w.bal(w.ata(S.publicKey));
  const tx = await (cp as any).createPositionAndAddLiquidity({
    owner: S.publicKey, pool: w.poolAddr, positionNft: nft.publicKey, liquidityDelta: dq.liquidityDelta,
    maxAmountTokenA: inA.muln(11).divn(10), maxAmountTokenB: dq.outputAmount.muln(11).divn(10).addn(1000),
    tokenAAmountThreshold: inA.muln(11).divn(10), tokenBAmountThreshold: dq.outputAmount.muln(11).divn(10).addn(1000),
    tokenAMint: w.mint.publicKey, tokenBMint: NATIVE_MINT, tokenAProgram: TP, tokenBProgram: TPT,
  });
  await sendSigned(tx, [S, nft]);
  const baseAfter = await baseNow();
  const votes = weight * COIN;
  const metLive = votes * 10_000n >= baseAfter * QBPS; // what the pre-v4.1 rule (live base) would say now
  const after = await attempt(() => w.execute(p.id, { recipient: w.tAta(w.me) }));
  const c1 = await w.bal(w.ata(S.publicKey));
  if (!shortBefore) record("A2c.1", "quorum by liquidity", "ERROR", "the control failed: the proposal was not short of quorum before the liquidity move: " + before.err.slice(0, 160));
  else recordFixed(
    "A2c.1",
    "a stranger ADDS 3M coins of liquidity to our pool (no swap, no 5% fee) → the live base shrinks; the vote was 0.05M coins short of the quorum",
    after.ok,
    `short of quorum before=${shortBefore}; live base ${coins(base0)} → ${coins(baseAfter)} coins (the pre-v4.1 live rule WOULD now be met=${metLive}); with the base frozen at open_voting executed=${after.ok}${after.ok ? "" : " " + after.err.slice(0, 80)}. The stranger only moved ${coins(c0 - c1)} coins into a position he can withdraw`
  );

  // and he can take it back out the same way (removing liquidity is free as well)
  let removed = false, err = "";
  try {
    const st2: any = await cp.fetchPoolState(w.poolAddr);
    const position = (await import("@meteora-ag/cp-amm-sdk")).derivePositionAddress(nft.publicKey);
    const nftAccount = (await import("@meteora-ag/cp-amm-sdk")).derivePositionNftAccount(nft.publicKey);
    const rm = await (cp as any).removeAllLiquidity({
      owner: S.publicKey, pool: w.poolAddr, position, positionNftAccount: nftAccount, tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0),
      tokenAMint: w.mint.publicKey, tokenBMint: NATIVE_MINT, tokenAVault: st2.tokenAVault, tokenBVault: st2.tokenBVault, tokenAProgram: TP, tokenBProgram: TPT, vestings: [], currentPoint: new BN(0),
    });
    await sendSigned(rm, [S]);
    removed = true;
  } catch (e) { err = errText(e).slice(0, 200); }
  const v1 = await w.solOf(S.publicKey);
  const c2 = await w.bal(w.ata(S.publicKey));
  const baseBack = await baseNow();
  record(
    "A2c.2",
    "…and the stranger withdraws it again: what did the whole round trip cost him?",
    removed ? "INFO" : "ERROR",
    removed ? `base back to ${coins(baseBack)} coins; coins returned ${coins(c2 - c1)}M-units of ${coins(c0 - c1)}; SOL change ${(Number(v1 - v0) / 1e9).toFixed(5)} (rent of the position + transaction fees only, no trading fee)` : err
  );
  finish("audit/results_a2c.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
