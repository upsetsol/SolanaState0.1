// Test helper (local validator only): create a SPEND proposal, enrol the given voters from ONE read of their balances,
// open the voting, and print the proposal id.
//
//   GOVERNANCE_MINT=<mint> ANCHOR_PROVIDER_URL=<local rpc> ANCHOR_WALLET=<owner key file>
//   VOTERS=<wallet>,<wallet>   (optional) REASON="..."   (optional)
//
// Run from the repository root:  npx ts-node agent-skill/test/open-proposal.ts

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, openVoting } from "../../scripts/lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;
  const voters = (process.env.VOTERS || "").split(",").filter(Boolean).map((s) => new PublicKey(s));

  const { id } = await createProposal(program, provider, { type: 0, target: me, amount: 1000, reason: process.env.REASON ?? "e2e: vote test" });
  for (const v of voters) await postSnapshot(program, provider, id, v);
  await openVoting(program, provider, id);
  console.log("PROPOSAL_ID=" + id.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
