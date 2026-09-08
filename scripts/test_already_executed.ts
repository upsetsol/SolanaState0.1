// Negative: execute an already-executed proposal again. Expect AlreadyExecuted.
//
//   GOVERNANCE_MINT=<mint>
//   PROPOSAL_ID=<id>   (a proposal already executed)

import { getProvider, loadProgram, executeProposal } from "./lib/env";

async function main() {
  const id = process.env.PROPOSAL_ID ?? "0";
  const provider = getProvider();
  const program = loadProgram(provider);

  console.log(`Re-executing proposal ${id}...`);
  try {
    await executeProposal(program, provider, id);
    console.log("❌ PROBLEM: it went through again");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("execute_proposal failed with:", msg, msg === "AlreadyExecuted" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
