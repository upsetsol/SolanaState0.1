// Timelock test (coarse): CHANGE_PARAM proposal, vote, then try to execute
// right after the voting deadline (expect TimelockNotElapsed) and again after
// deadline + timelock (expect success). Run execute_proposal.ts manually at
// the two points, or use test_timelock_precise.ts which waits by itself.
//
//   GOVERNANCE_MINT=<mint>

import { getProvider, loadProgram, createProposal, postSnapshot, castVote, proposalPda } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 4,
    target: me,
    amount: "60",
    paramKey: 7, // culture_daily_bps
    reason: "Test timelock",
  });
  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);

  const proposal = await program.account.proposal.fetch(proposalPda(id));
  console.log("proposal", id.toString(), "deadline:", proposal.deadline.toString());
  console.log(`\n1) right after the deadline: npx ts-node scripts/execute_proposal.ts ${id}   (expect TimelockNotElapsed)`);
  console.log(`2) after deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}   (expect success)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
