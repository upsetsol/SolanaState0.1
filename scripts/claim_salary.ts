// Claim a role's salary — once a day, a % of the MORNING treasury snapshot.
// Paid in the treasury asset (wSOL by default): the script creates your account for it if missing.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/president.json   (must be president / finance / culture minister)

import { SystemProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  getProvider,
  loadProgram,
  TREASURY_MINT,
  configPda,
  treasuryAta,
  treasuryAtaOf,
  PROGRAM_ID,
  TREASURY_PROGRAM,
  ATA_PROGRAM,
} from "./lib/env";

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
      config: configPda(),
      treasuryMint: TREASURY_MINT,
      payrollClaim: payrollClaimPda,
      treasury: treasuryAta(),
      claimantTokenAccount: treasuryAtaOf(me),
      tokenProgram: TREASURY_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(me, treasuryAtaOf(me), me, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM),
    ])
    .rpc();

  console.log("claim_salary tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
