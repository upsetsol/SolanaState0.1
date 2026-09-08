// admin_authority tunes the "who counts as a citizen" threshold (bps of supply).
// Deliberately off the voting path.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/admin.json     (must be config.admin_authority)
//   BPS=25                   (default: 25 = 0.25%)

import { anchor, getProvider, loadProgram, configPda } from "./lib/env";

async function main() {
  const bps = Number(process.env.BPS ?? "25");
  const provider = getProvider();
  const program = loadProgram(provider);

  const tx = await program.methods
    .setCitizenshipThreshold(new anchor.BN(bps))
    .accounts({ admin: provider.wallet.publicKey, config: configPda() })
    .rpc();

  console.log(`set_citizenship_threshold(${bps} bps) tx:`, tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
