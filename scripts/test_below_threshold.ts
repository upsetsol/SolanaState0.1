// Negative: a wallet below the proposal threshold tries to create a proposal.
// Expect BelowThreshold.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/holder-d.json   (a small holder)

import { getProvider, loadProgram, createProposal } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  console.log("Trying to create a proposal from", me.toBase58(), "...");
  try {
    await createProposal(program, provider, {
      type: 0,
      target: me,
      amount: "1000000000",
      reason: "Should fail — below threshold",
    });
    console.log("❌ PROBLEM: proposal created, expected a failure");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("create_proposal failed with:", msg, msg === "BelowThreshold" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
