// Reference flow: create a SPEND proposal (pay some of the treasury asset to our own
// wallet — a test scenario), post a snapshot for our wallet (the weight can't exceed the
// balance the program sees), OPEN the voting, then vote "for".
//
// The order matters: snapshots first, then `openVoting` (the voting clock and the frozen quorum
// base start there), then votes. For a real multi-holder vote use scripts/snapshot_all.ts, which
// scans all holders ONCE and posts exactly those weights.

import {
  anchor,
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  createProposal,
  postSnapshot,
  castVote,
  openVoting,
  ata,
} from "./lib/env";
import { getAccount } from "@solana/spl-token";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const spendAmount = new anchor.BN(process.env.AMOUNT ?? "1000000"); // raw units of the treasury asset (0.001 SOL)

  const { id, pda } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: spendAmount,
    reason: "Test spend — return to self",
  });
  console.log("create_proposal id:", id.toString(), "pda:", pda.toBase58());

  // Snapshot ALL voters before opening the voting.
  const acct = await getAccount(provider.connection, ata(me), "confirmed", TOKEN_2022_PROGRAM_ID);
  const sig2 = await postSnapshot(program, provider, id, me, acct.amount);
  console.log("post_voter_snapshot tx:", sig2, "| weight:", acct.amount.toString());

  const sigOpen = await openVoting(program, provider, id);
  console.log("open_voting tx:", sigOpen);

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
