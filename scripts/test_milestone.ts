// Milestone cycle: create milestone -> post VERIFIED citizen snapshots
// (weight is read on-chain) -> finalize. Then owners push payouts with
// scripts/claim_milestone.ts.
//
// The Milestone Fund must already hold tokens — top it up first via
// governance: scripts/deposit_to_milestone_fund.ts + execute_proposal.ts.
//
//   GOVERNANCE_MINT=<mint>
//   HOLDERS=<pubkey>,<pubkey>,...   citizens to snapshot (must hold >= 0.25% supply)

import { SystemProgram, PublicKey } from "@solana/web3.js";
import {
  anchor,
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  configPda,
  milestonePda,
  milestoneSnapPda,
  milestoneFundPda,
  ata,
  TOKEN_PROGRAM,
} from "./lib/env";

async function main() {
  if (!process.env.HOLDERS) throw new Error("Set HOLDERS=pk1,pk2,...");
  const holders = process.env.HOLDERS.split(",").map((s) => new PublicKey(s.trim()));

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const cfg = await program.account.config.fetch(configPda());
  const n: anchor.BN = cfg.nextMilestoneNumber;
  const mPda = milestonePda(n);

  // 1. create_milestone
  const tx1 = await program.methods
    .createMilestone()
    .accounts({
      owner: me,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      milestoneRecord: mPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("create_milestone tx:", tx1, "| milestone #", n.toString());

  // 2. post_milestone_snapshot x N (weight verified on-chain)
  for (const holder of holders) {
    const tx = await program.methods
      .postMilestoneSnapshot(n, holder)
      .accounts({
        owner: me,
        governanceMint: GOVERNANCE_MINT,
        config: configPda(),
        milestoneRecord: mPda,
        holderTokenAccount: ata(holder),
        milestoneSnapshot: milestoneSnapPda(mPda, holder),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`  snapshot ${holder.toBase58()}: tx ${tx}`);
  }

  // 3. finalize_milestone
  const tx3 = await program.methods
    .finalizeMilestone(n)
    .accounts({
      owner: me,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      milestoneRecord: mPda,
      previousMilestone: n.toNumber() > 1 ? milestonePda(n.toNumber() - 1) : null,
      milestoneFund: milestoneFundPda(),
      tokenProgram: TOKEN_PROGRAM,
    })
    .rpc();
  console.log("finalize_milestone tx:", tx3);

  const record = await program.account.milestoneRecord.fetch(mPda);
  console.log("\nFinalized:", {
    payoutBps: record.payoutBps.toString(),
    fundSnapshotAmount: record.fundSnapshotAmount.toString(),
    totalEligibleWeight: record.totalEligibleWeight.toString(),
  });
  console.log(
    `\nPay a citizen: HOLDER=<pk> MILESTONE=${n} npx ts-node scripts/claim_milestone.ts`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
