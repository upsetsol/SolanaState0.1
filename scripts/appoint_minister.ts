// Propose appointing TARGET as finance minister (APPOINT_ROLE, type 2),
// snapshot the caller, vote "for".
//
//   GOVERNANCE_MINT=<mint>
//   TARGET=<pubkey>          who to appoint (must differ from president/culture minister)

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, openVoting, castVote } from "./lib/env";

async function main() {
  if (!process.env.TARGET) throw new Error("Set TARGET to the finance-minister pubkey.");
  const target = new PublicKey(process.env.TARGET);

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 2,
    target,
    reason: "Appoint finance minister",
  });
  console.log("create_proposal (AppointFinance) id:", id.toString());

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
