// Create a proposal, vote once (ok), vote again (expect AlreadyVoted).
//
//   GOVERNANCE_MINT=<mint>

import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "1000000000",
    reason: "Test double-vote",
  });
  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("first vote ok");

  try {
    await castVote(program, provider, id, true);
    console.log("❌ PROBLEM: second vote went through");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("second vote failed with:", msg, msg === "AlreadyVoted" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
