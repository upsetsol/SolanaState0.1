// One-time: create the Milestone Fund token account (PDA) and record it in
// Config. Run once after initialize if milestones will be used.
//
//   GOVERNANCE_MINT=<mint>
//   (signer must be owners_authority)

import { SystemProgram } from "@solana/web3.js";
import {
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  configPda,
  milestoneFundPda,
  TOKEN_PROGRAM,
} from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);

  const tx = await program.methods
    .setupMilestoneFund()
    .accounts({
      owner: provider.wallet.publicKey,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      milestoneFund: milestoneFundPda(),
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("setup_milestone_fund tx:", tx);
  console.log("Milestone Fund:", milestoneFundPda().toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
