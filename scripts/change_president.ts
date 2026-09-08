// Propose changing the president (type 1), snapshot the caller, vote "for".
//
//   GOVERNANCE_MINT=<mint>
//   TARGET=<pubkey>          new president (must differ from both ministers)

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  if (!process.env.TARGET) throw new Error("Set TARGET to the new president's pubkey.");
  const target = new PublicKey(process.env.TARGET);

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 1,
    target,
    reason: "Change president",
  });
  console.log("create_proposal (ChangePresident) id:", id.toString());

  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("snapshot + vote ok");
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
