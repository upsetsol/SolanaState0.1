// The owner closes the enrolment and starts the voting clock for a proposal (all snapshots must be posted first).
// Freezes the quorum base = supply minus the pool vault balance right now. After this, votes are accepted and no
// snapshot can be added.
//
//   GOVERNANCE_MINT=<mint>   KEYPAIR=<owners_authority keypair>   PROPOSAL_ID=<id>

import { getProvider, loadProgram, openVoting } from "./lib/env";

async function main() {
  const proposalId = process.env.PROPOSAL_ID;
  if (!proposalId) throw new Error("Set PROPOSAL_ID.");
  const provider = getProvider();
  const program = loadProgram(provider);
  console.log("open_voting tx:", await openVoting(program, provider, proposalId));
}
main().catch((e) => { console.error(e); process.exit(1); });
