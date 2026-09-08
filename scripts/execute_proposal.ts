// Executes a proposal after the voting deadline + timelock have passed.
// owners_authority ONLY (the provider wallet must be config.owners_authority).
//
//   npx ts-node scripts/execute_proposal.ts <id> [--spend | --milestone-deposit]
//
//   --spend             SPEND (type 0): recipient ATA is derived from proposal.target
//   --milestone-deposit  DEPOSIT_TO_MILESTONE_FUND (type 6)

import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, executeProposal, ata, proposalPda } from "./lib/env";

async function main() {
  const id = process.argv[2] ?? "0";
  const flags = process.argv.slice(3);
  const provider = getProvider();
  const program = loadProgram(provider);

  const opts: { recipient?: PublicKey; milestoneFund?: boolean } = {};

  if (flags.includes("--spend")) {
    const proposal = await program.account.proposal.fetch(proposalPda(id));
    opts.recipient = ata(proposal.target as PublicKey);
    console.log("SPEND — recipient ATA:", opts.recipient.toBase58());
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
