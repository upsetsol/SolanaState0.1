// A7 — blast radius of a stolen / dishonest OWNER key (owners_authority) WITHOUT any vote.
// The owner alone decides who is snapshotted for a milestone, and a milestone pays 30%→50% of the fund's free balance.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a7_rogue_owner.ts
import { makeWorld, group, record, COIN, SOL, finish } from "./lib";

async function main() {
  group("A7 rogue owner");
  const w = await makeWorld({ name: "a7", params: { cooldown: 0, grace: 3600, citizenBps: 25 } });
  const honest = await w.holder(60_000_000n, 10); // a real citizen who is simply never snapshotted
  await w.ensureT(w.me);
  const fund0 = 10n * SOL;
  await w.fundMilestoneDirect(fund0); // the community voted this money into the citizens' fund
  const mine0 = await w.tbal(w.tAta(w.me));
  let prev: any = null;
  const steps: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const ms = await w.createMilestone();
    await w.msSnap(ms.n, ms.m, w.me); // the owner "enrols" only himself (he holds ≥ 0.25% of supply)
    await w.msFinalize(ms.n, ms.m, prev);
    await w.msClaim(ms.n, ms.m, w.me, w.payer);
    prev = ms.m;
    const left = await w.tbal(w.milestoneFundPda);
    steps.push(`#${i}: fund left ${(Number(left) / 1e9).toFixed(3)} SOL`);
  }
  const mine1 = await w.tbal(w.tAta(w.me));
  const left = await w.tbal(w.milestoneFundPda);
  record(
    "A7.1",
    "owner key alone empties the citizens' milestone fund into his own wallet: snapshot only himself, finalize, claim — five times in a row, no vote, no timelock",
    mine1 - mine0 > (fund0 * 9n) / 10n ? "EXPLOITABLE" : "BLOCKED",
    `${steps.join(" | ")} → owner took ${(Number(mine1 - mine0) / 1e9).toFixed(3)} of ${(Number(fund0) / 1e9).toFixed(0)} SOL (${(Number(mine1 - mine0) * 100 / Number(fund0)).toFixed(1)}%), the honest 6% holder got 0`
  );
  // ---- A7.2: the owner is also the only one who decides WHO votes. Holding more than the quorum himself (a founder
  // usually does), he enrols only himself and passes 30%-of-treasury SPENDs to himself, one per cooldown (0 here).
  {
    await w.seedTreasury(5n * SOL);
    const t0 = await w.tbal(w.treasury);
    const rounds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const cur = await w.tbal(w.treasury);
      const amount = (cur * 29n) / 100n; // just under the 30% cap
      const p = await w.propose(0, w.me, amount, 0, `owner pays himself #${i}`);
      await w.snapshot(p.id, p.pPda, w.me); // the honest 6% holder is simply never enrolled
      await w.vote(w.payer, p.id, p.pPda, true);
      await w.waitExecutable(p.pPda);
      await w.execute(p.id, { recipient: w.tAta(w.me) });
      rounds.push(`#${i} took ${(Number(amount) / 1e9).toFixed(3)} SOL`);
    }
    const t1 = await w.tbal(w.treasury);
    record(
      "A7.2",
      "owner enrols only himself (he holds 94% of the coins) and votes SPEND-to-himself three times in a row",
      t1 < (t0 * 40n) / 100n ? "EXPLOITABLE" : "BLOCKED",
      `${rounds.join(" | ")} → treasury ${(Number(t0) / 1e9).toFixed(2)} → ${(Number(t1) / 1e9).toFixed(2)} SOL (${(Number(t1) * 100 / Number(t0)).toFixed(0)}% left, 0.71^n); each round needs only vote+timelock, nobody else could vote`
    );
  }
  finish("audit/results_a7.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
