// Negative: a non-owner tries to post a snapshot for themselves. Expect NotOwner.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/holder-d.json    (NOT owners_authority)
//   PROPOSAL_ID=<id>           an existing proposal whose voting has not been opened yet

import { anchor, getProvider, loadProgram, configPda, proposalPda, voterSnapshotPda, ata, SystemProgram } from "./lib/env";

async function main() {
  const proposalId = process.env.PROPOSAL_ID ?? "0";
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;
  const pda = proposalPda(proposalId);

  console.log(me.toBase58(), "tries to self-post a snapshot...");
  try {
    await program.methods
      .postVoterSnapshot(new anchor.BN(proposalId), me, new anchor.BN(1))
      .accounts({
        owner: me,
        config: configPda(),
        proposal: pda,
        voterTokenAccount: ata(me),
        voterSnapshot: voterSnapshotPda(pda, me),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("❌ PROBLEM: it went through");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("post_voter_snapshot failed with:", msg, msg === "NotOwner" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
