// Executes a proposal after the voting deadline + timelock have passed.
// owners_authority ONLY (the provider wallet must be config.owners_authority).
//
//   npx ts-node scripts/execute_proposal.ts <id> [--spend | --milestone-deposit]
//
//   --spend             SPEND (type 0): the recipient's account for the TREASURY asset is derived
//                       from proposal.target (created on the fly if it does not exist)
//   --milestone-deposit  DEPOSIT_TO_MILESTONE_FUND (type 6)

import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { getProvider, loadProgram, executeProposal, treasuryAtaOf, proposalPda, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM } from "./lib/env";

async function main() {
  const id = process.argv[2] ?? "0";
  const flags = process.argv.slice(3);
  const provider = getProvider();
  const program = loadProgram(provider);

  const opts: { recipient?: PublicKey; milestoneFund?: boolean } = {};

  if (flags.includes("--spend")) {
    const proposal = await program.account.proposal.fetch(proposalPda(id));
    const target = proposal.target as PublicKey;
    opts.recipient = treasuryAtaOf(target);
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(provider.wallet.publicKey, opts.recipient, target, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM)
      )
    );
    console.log("SPEND — recipient account:", opts.recipient.toBase58());
  }
  if (flags.includes("--milestone-deposit")) {
    opts.milestoneFund = true;
  }

  const tx = await executeProposal(program, provider, id, opts);
  console.log("execute_proposal tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
