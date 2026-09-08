// admin_authority flips the global pause on all treasury/fund outflows.
// Break-glass while a bug is being patched.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/admin.json          (must be config.admin_authority)
//   PAUSED=true|false             (default: true)

import { getProvider, loadProgram, configPda } from "./lib/env";

async function main() {
  const paused = (process.env.PAUSED ?? "true").toLowerCase() !== "false";
  const provider = getProvider();
  const program = loadProgram(provider);

  const tx = await program.methods
    .setPause(paused)
    .accounts({ admin: provider.wallet.publicKey, config: configPda() })
    .rpc();

  console.log(`set_pause(${paused}) tx:`, tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
