// Propose appointing TARGET as culture minister (APPOINT_ROLE, type 3),
// snapshot the caller, vote "for".
//
//   GOVERNANCE_MINT=<mint>
//   TARGET=<pubkey>          must differ from president/finance minister

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  if (!process.env.TARGET) throw new Error("Set TARGET to the culture-minister pubkey.");
  const target = new PublicKey(process.env.TARGET);

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 3,
    target,
    reason: "Appoint culture minister",
  });
  console.log("create_proposal (AppointCulture) id:", id.toString());

  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("snapshot + vote ok");
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
