// A3 — milestone payouts are real money, so they are the juiciest target for holders / traders.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a3_milestones.ts
import { makeWorld, group, record, COIN, SOL, finish } from "./lib";

const coins = (n: bigint) => n / COIN;
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

async function main() {
  group("A3 milestones");
  const w = await makeWorld({ name: "a3", params: { cooldown: 0, grace: 10, citizenBps: 25 } });
  const A = await w.holder(200_000_000n, 20); // 20%
  const B = await w.holder(60_000_000n, 20); // 6%
  await w.withPool(300_000_000n, 30n * SOL);

  // ------------------------------------------------------------------------------------------------
  // A3.1 wallet hopping: the same coins earn a payout share in every wallet the owner snapshots
  // ------------------------------------------------------------------------------------------------
  const A2 = await w.holder(0n, 5);
  const A3 = await w.holder(0n, 5); // ends up holding A's 200M after A3.1
  {
    await w.fundMilestoneDirect(10n * SOL); // → payout pool = 30% = 3 SOL
    const ms = await w.createMilestone();
    await w.msSnap(ms.n, ms.m, A.publicKey); // 200M
    await w.transferCoins(A, A2.publicKey, 200_000_000n); // slipped in between two owner transactions
    await w.msSnap(ms.n, ms.m, A2.publicKey); // 200M again
    await w.transferCoins(A2, A3.publicKey, 200_000_000n);
    await w.msSnap(ms.n, ms.m, A3.publicKey); // and again
    await w.msSnap(ms.n, ms.m, B.publicKey); // 60M, honest
    await w.msFinalize(ms.n, ms.m);
    const rec = await w.program.account.milestoneRecord.fetch(ms.m);
    const pool = (BigInt((rec.fundSnapshotAmount).toString()) * BigInt(rec.payoutBps.toString())) / 10_000n;
    const before = await Promise.all([A, A2, A3, B].map((k) => w.tbal(w.tAta(k.publicKey))));
    for (const k of [A, A2, A3, B]) await w.msClaim(ms.n, ms.m, k.publicKey);
    const after = await Promise.all([A, A2, A3, B].map((k) => w.tbal(w.tAta(k.publicKey))));
    const got = after.map((x, i) => x - before[i]);
    const attacker = got[0] + got[1] + got[2];
    const fairA = (pool * 200n) / 260n; // A really owns 200M, B 60M
    const fairB = pool - fairA;
    record(
      "A3.1",
      "wallet hopping: 200M real coins snapshotted in 3 wallets → payout pool split by weight",
      attacker > fairA ? "EXPLOITABLE" : "BLOCKED",
      `payout pool ${sol(pool)} SOL; attacker got ${sol(attacker)} SOL (fair share ${sol(fairA)}), honest B got ${sol(got[3])} SOL (fair ${sol(fairB)}) → B is short by ${((1 - Number(got[3]) / Number(fairB)) * 100).toFixed(0)}%. total_eligible_weight=${coins(BigInt(rec.totalEligibleWeight.toString())) / 1_000_000n}M vs real holdings of the three actors 260M`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A3.2 flash holder: buy → be snapshotted → sell → collect.  Profitable only when the fund is big
  // ------------------------------------------------------------------------------------------------
  {
    const X = await w.holder(0n, 500);
    const results: string[] = [];
    let prev: any = w.milestonePda(1); // milestone 1 was used by A3.1
    let profitableAtBig = false, lostAtSmall = false;
    for (const [label, targetBase] of [["small fund", 5n * SOL], ["medium fund", 15n * SOL], ["big fund", 100n * SOL]] as [string, bigint][]) {
      const fundBal = await w.tbal(w.milestoneFundPda);
      const reserved = BigInt((await w.cfg()).milestoneReserved.toString());
      if (fundBal - reserved < targetBase) await w.fundMilestoneDirect(targetBase - (fundBal - reserved));
      const ms = await w.createMilestone();
      await w.msSnap(ms.n, ms.m, A3.publicKey); // the 200M whale (his coins sit in A3 after A3.1)
      await w.msSnap(ms.n, ms.m, B.publicKey);
      const v0 = await w.solOf(X.publicKey);
      await w.swap(X, "buy", 8n * SOL);
      const held = await w.bal(w.ata(X.publicKey));
      await w.msSnap(ms.n, ms.m, X.publicKey); // the owner scans holders → X is a "citizen" right now
      await w.swap(X, "sell", coins(held)); // …and leaves right after the snapshot
      await w.msFinalize(ms.n, ms.m, w.milestonePda(BigInt(ms.n.toString()) - 1n));
      const rec = await w.program.account.milestoneRecord.fetch(ms.m);
      const pool = (BigInt(rec.fundSnapshotAmount.toString()) * BigInt(rec.payoutBps.toString())) / 10_000n;
      await w.ensureT(X.publicKey); // the SDK closed X's wSOL account when it unwrapped the sale proceeds
      for (const k of [A3, B, X]) await w.msClaim(ms.n, ms.m, k.publicKey);
      const v1 = await w.solOf(X.publicKey);
      const net = v1 - v0;
      results.push(`${label}: payout pool ${sol(pool)} SOL → X net ${net >= 0n ? "+" : ""}${sol(net)} SOL`);
      if (label === "big fund" && net > 0n) profitableAtBig = true;
      if (label === "small fund" && net < 0n) lostAtSmall = true;
    }
    record(
      "A3.2",
      "flash holder: buy 6% of supply → owner snapshots → sell → collect the milestone share",
      profitableAtBig ? "EXPLOITABLE" : "BLOCKED",
      `${results.join(" | ")}. Round trip (two 5% fees + slippage) costs ≈0.78 SOL here; rule of thumb: profitable when the milestone fund > about 1/3 of the market value of all eligible holdings. Loses at the small fund=${lostAtSmall}`
    );
  }

  finish("audit/results_a3.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
