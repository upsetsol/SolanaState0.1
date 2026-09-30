// Claim a role's salary — once a day, a % of the MORNING treasury snapshot.
// Paid in the treasury asset (wSOL by default): the script creates your account for it if missing.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/president.json   (must be president / finance / culture minister)
//
// The "salary already paid today" record is kept per ROLE (0 president, 1 finance, 2 culture); the script finds
// your role from the Config.

import { SystemProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  getProvider,
  loadProgram,
  TREASURY_MINT,
  configPda,
  treasuryAta,
  treasuryAtaOf,
  payrollPda,
  TREASURY_PROGRAM,
  ATA_PROGRAM,
} from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const cfg: any = await program.account.config.fetch(configPda());
  const role = me.equals(cfg.president) ? 0 : me.equals(cfg.financeMinister) ? 1 : me.equals(cfg.cultureMinister) ? 2 : -1;
  if (role < 0) throw new Error("this wallet is not the president / finance minister / culture minister");
  const payrollClaimPda = payrollPda(role);

  const tx = await program.methods
    .claimSalary(role)
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
