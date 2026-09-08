// Reference flow: create a SPEND proposal (return some treasury to our own
// wallet — a test scenario), post a VERIFIED snapshot for our wallet (weight
// is read on-chain from the token account, not passed in), then vote "for".
//
// Snapshots must be posted BEFORE the first vote — the program rejects a
// snapshot once voting has started.

import {
  anchor,
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  createProposal,
  postSnapshot,
  castVote,
  ata,
} from "./lib/env";
import { getAccount } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const spendAmount = new anchor.BN(process.env.AMOUNT ?? "100000000000000"); // 100k @ 9dp

  const { id, pda } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: spendAmount,
    reason: "Test spend — return to self",
  });
  console.log("create_proposal id:", id.toString(), "pda:", pda.toBase58());

  // Snapshot ALL voters before anyone votes.
  const sig2 = await postSnapshot(program, provider, id, me);
  const acct = await getAccount(provider.connection, ata(me), "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("post_voter_snapshot tx:", sig2, "| verified weight:", acct.amount.toString());

  const sig3 = await castVote(program, provider, id, true);
  console.log("vote tx:", sig3);

  console.log(
    `\nDone. Wait for the voting deadline + timelock, then: npx ts-node scripts/execute_proposal.ts ${id} --spend`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
