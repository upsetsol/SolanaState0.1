// Claim a role's salary — once a day, a % of the MORNING treasury snapshot.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/president.json   (must be president / finance / culture minister)

import { SystemProgram } from "@solana/web3.js";
import {
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  configPda,
  treasuryAta,
  ata,
  PROGRAM_ID,
  TOKEN_PROGRAM,
} from "./lib/env";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const [payrollClaimPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("payroll"), configPda().toBuffer(), me.toBuffer()],
    PROGRAM_ID
  );

  const tx = await program.methods
    .claimSalary()
    .accounts({
      claimant: me,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      payrollClaim: payrollClaimPda,
      treasury: treasuryAta(),
      claimantTokenAccount: ata(me),
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("claim_salary tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
