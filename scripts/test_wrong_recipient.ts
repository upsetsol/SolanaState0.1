// Set up the WrongRecipient test: SPEND proposal with target = me, snapshot,
// vote. Then run execute_wrong_recipient.ts (feeds a different recipient).
//
//   GOVERNANCE_MINT=<mint>

import { getProvider, loadProgram, createProposal, postSnapshot, openVoting, castVote } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "1000000000",
    reason: "Test wrong recipient guard",
  });
  await postSnapshot(program, provider, id, me);
  await openVoting(program, provider, id);
  await castVote(program, provider, id, true);
  console.log("proposal", id.toString(), "ready (target = me)");
  console.log(
    `\nAfter deadline + timelock: PROPOSAL_ID=${id} WRONG_HOLDER=<pk> npx ts-node scripts/execute_wrong_recipient.ts`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
