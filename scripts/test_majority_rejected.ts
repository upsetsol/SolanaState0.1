// Two holders vote: one big "against", one small "for". Together they clear
// quorum, but against > for. After the deadline, execute_proposal should fail
// with ProposalRejected.
//
//   GOVERNANCE_MINT=<mint>
//   AGAINST_KEYPAIR=~/holder-b.json   (bigger holder, votes against)
//   FOR_KEYPAIR=~/holder-c.json       (smaller holder, votes for)

import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const againstP = getProvider(process.env.AGAINST_KEYPAIR ?? "~/holder-b.json");
  const forP = getProvider(process.env.FOR_KEYPAIR ?? "~/holder-c.json");
  const againstProgram = loadProgram(againstP);
  const forProgram = loadProgram(forP);

  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "1000000000",
    reason: "Test majority rejected",
  });

  await postSnapshot(program, provider, id, againstP.wallet.publicKey);
  await postSnapshot(program, provider, id, forP.wallet.publicKey);

  await castVote(againstProgram, againstP, id, false);
  await castVote(forProgram, forP, id, true);

  console.log(`proposal ${id}: ${againstP.wallet.publicKey.toBase58()} against, ${forP.wallet.publicKey.toBase58()} for`);
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}  (expect ProposalRejected)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
