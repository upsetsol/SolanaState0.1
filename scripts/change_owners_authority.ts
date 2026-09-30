// Propose changing owners_authority (type 5 — the most sensitive change),
// snapshot the caller, vote "for".
//
//   GOVERNANCE_MINT=<mint>
//   TARGET=<pubkey>          new owners_authority (e.g. a Squads vault)

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, openVoting, castVote } from "./lib/env";

async function main() {
  if (!process.env.TARGET) throw new Error("Set TARGET to the new owners_authority.");
  const target = new PublicKey(process.env.TARGET);

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 5,
    target,
    reason: "Change owners_authority",
  });
  console.log("create_proposal (ChangeOwnersAuthority) id:", id.toString());

  await postSnapshot(program, provider, id, me);
  await openVoting(program, provider, id);
  await castVote(program, provider, id, true);
  console.log("snapshot + vote ok");
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
