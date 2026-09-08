// Negative: once someone has voted, owners can no longer add snapshots.
// Expect VotingAlreadyStarted.
//
//   GOVERNANCE_MINT=<mint>
//   OTHER=<pubkey>   a second holder to try to snapshot after the first vote

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  if (!process.env.OTHER) throw new Error("Set OTHER to a second holder's pubkey.");
  const other = new PublicKey(process.env.OTHER);

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "1000000000",
    reason: "Test late snapshot",
  });
  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("first vote cast");

  try {
    await postSnapshot(program, provider, id, other);
    console.log("❌ PROBLEM: snapshot added after voting started");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("post_voter_snapshot failed with:", msg, msg === "VotingAlreadyStarted" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
