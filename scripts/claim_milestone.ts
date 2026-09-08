// Push a citizen's milestone payout to their ATA. The citizen does NOT sign —
// whoever runs this (in practice: owners) pays the tx fee and the tokens go to
// the recorded holder. Once per milestone, after finalize_milestone.
//
//   GOVERNANCE_MINT=<mint>
//   MILESTONE=1
//   HOLDER=<pubkey>          (the citizen to pay)

import { PublicKey } from "@solana/web3.js";
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
  const milestoneNumber = new anchor.BN(process.env.MILESTONE ?? "1");
  if (!process.env.HOLDER) throw new Error("Set HOLDER to the citizen's pubkey.");
  const holder = new PublicKey(process.env.HOLDER);

  const provider = getProvider();
  const program = loadProgram(provider);

  const mPda = milestonePda(milestoneNumber);

  const tx = await program.methods
    .claimMilestone(milestoneNumber, holder)
    .accounts({
      payer: provider.wallet.publicKey,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      milestoneRecord: mPda,
      milestoneSnapshot: milestoneSnapPda(mPda, holder),
      milestoneFund: milestoneFundPda(),
      claimantTokenAccount: ata(holder),
      tokenProgram: TOKEN_PROGRAM,
    })
    .rpc();

  console.log(`claim_milestone (holder ${holder.toBase58()}) tx:`, tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
