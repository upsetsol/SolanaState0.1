// Close a milestone after its claim grace period: the unclaimed part of the
// pool returns to the Milestone Fund's free balance. owners_authority only.
// Claims on the milestone are no longer possible afterwards.
//
//   GOVERNANCE_MINT=<mint>
//   MILESTONE=1

import { anchor, getProvider, loadProgram, GOVERNANCE_MINT, configPda, milestonePda } from "./lib/env";

async function main() {
  const n = new anchor.BN(process.env.MILESTONE ?? "1");
  const provider = getProvider();
  const program = loadProgram(provider);

  const tx = await program.methods
    .releaseMilestoneReserve(n)
    .accounts({
      owner: provider.wallet.publicKey,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      milestoneRecord: milestonePda(n),
    })
    .rpc();
  console.log(`release_milestone_reserve(#${n}) tx:`, tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
