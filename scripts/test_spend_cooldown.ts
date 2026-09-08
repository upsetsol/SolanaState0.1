// Negative: execute two money-moving proposals within spend_cooldown_secs.
// The second execute should fail with SpendCooldown.
//
//   GOVERNANCE_MINT=<mint>
//   FIRST_ID=<id>    a passed SPEND proposal, already executed
//   SECOND_ID=<id>   another passed SPEND proposal, ready to execute

import { getProvider, loadProgram, executeProposal, proposalPda, ata } from "./lib/env";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const secondId = process.env.SECOND_ID ?? "1";
  const provider = getProvider();
  const program = loadProgram(provider);

  const proposal = await program.account.proposal.fetch(proposalPda(secondId));
  console.log(`Executing proposal ${secondId} right after the previous spend...`);
  try {
    await executeProposal(program, provider, secondId, {
      recipient: ata(proposal.target as PublicKey),
    });
    console.log("❌ PROBLEM: second spend went through inside the cooldown");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("execute_proposal failed with:", msg, msg === "SpendCooldown" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
