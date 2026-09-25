// Negative: execute a SPEND proposal feeding a recipient token account whose
// owner != proposal.target. Expect WrongRecipient.
//
//   GOVERNANCE_MINT=<mint>
//   PROPOSAL_ID=<id>        a passed SPEND proposal (target != WRONG_HOLDER)
//   WRONG_HOLDER=<pubkey>   whose account for the treasury asset we wrongly feed (created if missing)

import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getProvider, loadProgram, executeProposal, treasuryAtaOf, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM } from "./lib/env";

async function main() {
  const id = process.env.PROPOSAL_ID ?? "0";
  if (!process.env.WRONG_HOLDER) throw new Error("Set WRONG_HOLDER.");
  const wrong = new PublicKey(process.env.WRONG_HOLDER);

  const provider = getProvider();
  const program = loadProgram(provider);

  // the wrong holder's account must exist, otherwise the error would be "account not initialized"
  await provider.sendAndConfirm(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(provider.wallet.publicKey, treasuryAtaOf(wrong), wrong, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM)
    )
  );
  console.log("Executing with a swapped recipient...");
  try {
    await executeProposal(program, provider, id, { recipient: treasuryAtaOf(wrong) });
    console.log("❌ PROBLEM: went through with a swapped recipient");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("execute_proposal failed with:", msg, msg === "WrongRecipient" ? "✅ guard works" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
