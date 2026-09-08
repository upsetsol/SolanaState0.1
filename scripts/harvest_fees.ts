// harvest_fees — permissionless. Sweeps the Token-2022 withheld transfer-fee
// tax off the given accounts into the treasury. Not pause-gated (it's an
// inflow). Someone has to run this regularly (bot/cron) — it doesn't self-fire.
//
//   GOVERNANCE_MINT=<mint>
//   ACCOUNTS=<tokenAccount>,<tokenAccount>,...   accounts to harvest from

import { PublicKey } from "@solana/web3.js";
import {
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  configPda,
  treasuryAta,
  TOKEN_PROGRAM,
} from "./lib/env";

async function main() {
  if (!process.env.ACCOUNTS) throw new Error("Set ACCOUNTS=tokenAcc1,tokenAcc2,...");
  const accounts = process.env.ACCOUNTS.split(",").map((s) => new PublicKey(s.trim()));

  const provider = getProvider();
  const program = loadProgram(provider);

  console.log("Harvesting from:", accounts.map((p) => p.toBase58()));

  const tx = await program.methods
    .harvestFees()
    .accounts({
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      treasury: treasuryAta(),
      tokenProgram: TOKEN_PROGRAM,
    })
    .remainingAccounts(
      accounts.map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }))
    )
    .rpc();

  console.log("\nharvest_fees tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
