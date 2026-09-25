// Autonomous minister spend (no vote, within the per-ROLE rolling limit).
// The spend tracker is keyed by role (1 = finance, 2 = culture), not by
// wallet — swapping the minister's key does not reset the weekly window.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/holder-b.json     (the minister's own key)
//   ROLE=1|2                    (1 = finance, default; 2 = culture)
//   AMOUNT=<raw>                (raw units of the treasury asset, default 1000000 = 0.001 SOL)

import { SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  anchor,
  getProvider,
  loadProgram,
  TREASURY_MINT,
  configPda,
  treasuryAta,
  treasuryAtaOf,
  spendTrackerPda,
  TREASURY_PROGRAM,
  ATA_PROGRAM,
} from "./lib/env";

async function main() {
  const role = Number(process.env.ROLE ?? "1");
  if (role !== 1 && role !== 2) throw new Error("ROLE must be 1 (finance) or 2 (culture)");
  const amount = new anchor.BN(process.env.AMOUNT ?? "1000000");

  const provider = getProvider();
  const program = loadProgram(provider);
  const minister = provider.wallet.publicKey;
  console.log("Minister:", minister.toBase58(), "role:", role, "amount:", amount.toString());

  const tx = await program.methods
    .ministerSpend(role, amount, "Test minister spend")
    .accounts({
      minister,
      config: configPda(),
      treasuryMint: TREASURY_MINT,
      spendTracker: spendTrackerPda(role),
      treasury: treasuryAta(),
      recipientTokenAccount: treasuryAtaOf(minister),
      tokenProgram: TREASURY_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([
      createAssociatedTokenAccountIdempotentInstruction(minister, treasuryAtaOf(minister), minister, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM),
    ])
    .rpc();

  console.log("minister_spend tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
