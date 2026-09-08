// Set up a QuorumNotReached case: proposal created by us, but only one small
// holder votes (below quorum). After deadline + timelock, execute_proposal
// should fail with QuorumNotReached.
//
//   GOVERNANCE_MINT=<mint>
//   VOTER_KEYPAIR=~/holder-c.json   a small holder (below quorum on its own)

import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  const provider = getProvider(); // owners_authority / creator
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const voterProvider = getProvider(process.env.VOTER_KEYPAIR ?? "~/holder-c.json");
  const voterProgram = loadProgram(voterProvider);
  const voter = voterProvider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "1000000000",
    reason: "Test quorum not reached",
  });
  await postSnapshot(program, provider, id, voter); // snapshot ONLY the small holder
  await castVote(voterProgram, voterProvider, id, true);
  console.log(`proposal ${id} — only ${voter.toBase58()} voted`);
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}  (expect QuorumNotReached)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
