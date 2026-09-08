// Negative: a non-owner tries to execute a passed proposal. Expect NotOwner.
//
//   GOVERNANCE_MINT=<mint>
//   KEYPAIR=~/holder-d.json   (NOT owners_authority)
//   PROPOSAL_ID=<id>          a proposal past deadline + timelock that would otherwise pass

import { getProvider, loadProgram, executeProposal } from "./lib/env";

async function main() {
  const id = process.env.PROPOSAL_ID ?? "0";
  const provider = getProvider();
  const program = loadProgram(provider);

  console.log(provider.wallet.publicKey.toBase58(), "tries to execute proposal", id);
  try {
    await executeProposal(program, provider, id);
    console.log("❌ PROBLEM: non-owner executed a proposal");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("execute_proposal failed with:", msg, msg === "NotOwner" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
