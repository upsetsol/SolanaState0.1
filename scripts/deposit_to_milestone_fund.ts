// Top up the Milestone Fund — now ONLY through governance (proposal type 6),
// capped at config.milestone_deposit_bps of the treasury.
//
// This script creates the proposal, posts a verified snapshot for the caller
// and votes "for". After deadline + timelock:
//   npx ts-node scripts/execute_proposal.ts <id> --milestone-deposit
//
//   GOVERNANCE_MINT=<mint>
//   AMOUNT=<raw>       deposit amount (must be <= cap)

import {
  anchor,
  getProvider,
  loadProgram,
  createProposal,
  postSnapshot,
  castVote,
} from "./lib/env";

async function main() {
  const amount = new anchor.BN(process.env.AMOUNT ?? "0");
  if (amount.isZero()) throw new Error("Set AMOUNT (raw) to deposit.");

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 6,
    target: me, // unused for type 6, must be a valid pubkey
    amount,
    reason: "Top up the Milestone Fund",
  });
  console.log("create_proposal (DEPOSIT_TO_MILESTONE_FUND) id:", id.toString());

  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("snapshot + vote ok");
  console.log(
    `\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id} --milestone-deposit`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
