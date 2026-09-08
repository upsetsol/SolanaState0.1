// Autonomous minister spend (no vote, within the per-ROLE rolling limit).
// The spend tracker is keyed by role (1 = finance, 2 = culture), not by
// wallet — swapping the minister's key does not reset the weekly window.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/holder-b.json     (the minister's own key)
//   ROLE=1|2                    (1 = finance, default; 2 = culture)
//   AMOUNT=<raw>                (default 10000000000000 = 10k @ 9dp)

import { SystemProgram } from "@solana/web3.js";
import {
  anchor,
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  configPda,
  treasuryAta,
  spendTrackerPda,
  ata,
  TOKEN_PROGRAM,
} from "./lib/env";

async function main() {
  const role = Number(process.env.ROLE ?? "1");
  if (role !== 1 && role !== 2) throw new Error("ROLE must be 1 (finance) or 2 (culture)");
  const amount = new anchor.BN(process.env.AMOUNT ?? "10000000000000");

  const provider = getProvider();
  const program = loadProgram(provider);
  const minister = provider.wallet.publicKey;
  console.log("Minister:", minister.toBase58(), "role:", role, "amount:", amount.toString());

  const tx = await program.methods
    .ministerSpend(role, amount, "Test minister spend")
    .accounts({
      minister,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      spendTracker: spendTrackerPda(role),
      treasury: treasuryAta(),
      recipientTokenAccount: ata(minister),
      tokenProgram: TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("minister_spend tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
