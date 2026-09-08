// Part 2 (run after part1's proposal clears deadline + timelock):
//  1. execute CHANGE_OWNERS_AUTHORITY -> vault
//  2. create a fresh proposal
//  3. post a voter snapshot signed BY THE VAULT via Squads (create -> propose
//     -> approve x2 -> execute)
//
//   GOVERNANCE_MINT=<mint>
//   MULTISIG=<pda> VAULT=<pda> CHANGE_PROPOSAL_ID=<id>
//   SECOND_MEMBER=~/holder-b.json

import * as multisig from "@sqds/multisig";
import { PublicKey, TransactionMessage } from "@solana/web3.js";
import * as os from "os";
import {
  anchor,
  getProvider,
  loadProgram,
  loadKeypair,
  GOVERNANCE_MINT,
  configPda,
  proposalPda,
  voterSnapshotPda,
  ata,
  createProposal,
  executeProposal,
  SystemProgram,
} from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const connection = provider.connection;
  const me = provider.wallet.publicKey;

  const multisigPda = new PublicKey(process.env.MULTISIG!);
  const vaultPda = new PublicKey(process.env.VAULT!);
  const changeProposalId = process.env.CHANGE_PROPOSAL_ID!;

  const creator = loadKeypair(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
  const secondMember = loadKeypair(process.env.SECOND_MEMBER || `${os.homedir()}/holder-b.json`);

  // 1. execute the ownership change
  try {
    await executeProposal(program, provider, changeProposalId);
    console.log("✅ owners_authority moved to the vault");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    if (msg === "AlreadyExecuted") console.log("(already executed — ok)");
    else throw e;
  }

  const cfg = await program.account.config.fetch(configPda());
  console.log("owners_authority == vault?", cfg.ownersAuthority.equals(vaultPda));

  // 2. new proposal (still created by us — anyone can create)
  const { id } = await createProposal(program, provider, {
    type: 0,
    target: me,
    amount: "0",
    reason: "Test squads-signed snapshot",
  });
  console.log("test proposal id:", id.toString());

  // 3. build post_voter_snapshot with owner = vault, execute it through Squads
  const pPda = proposalPda(id);
  const snapshotIx = await program.methods
    .postVoterSnapshot(new anchor.BN(id.toString()), me)
    .accounts({
      owner: vaultPda,
      config: configPda(),
      proposal: pPda,
      voterTokenAccount: ata(me),
      voterSnapshot: voterSnapshotPda(pPda, me),
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const msgV0 = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [snapshotIx],
  });

  const info = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  const txIndex = BigInt(Number(info.transactionIndex) + 1);

  await connection.confirmTransaction(
    await multisig.rpc.vaultTransactionCreate({
      connection,
      feePayer: creator,
      multisigPda,
      transactionIndex: txIndex,
      creator: creator.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: msgV0,
      memo: "post_voter_snapshot via Squads",
    }),
    "confirmed"
  );
  await connection.confirmTransaction(
    await multisig.rpc.proposalCreate({ connection, feePayer: creator, multisigPda, transactionIndex: txIndex, creator }),
    "confirmed"
  );
  await connection.confirmTransaction(
    await multisig.rpc.proposalApprove({ connection, feePayer: creator, multisigPda, transactionIndex: txIndex, member: creator }),
    "confirmed"
  );
  await connection.confirmTransaction(
    await multisig.rpc.proposalApprove({ connection, feePayer: creator, multisigPda, transactionIndex: txIndex, member: secondMember }),
    "confirmed"
  );
  const exec = await multisig.rpc.vaultTransactionExecute({
    connection,
    feePayer: creator,
    multisigPda,
    transactionIndex: txIndex,
    member: creator.publicKey,
    signers: [creator],
    sendOptions: { skipPreflight: true },
  });
  await connection.confirmTransaction(exec, "confirmed");
  console.log("✅✅ snapshot posted via multisig:", exec);

  const snap = await program.account.voterSnapshot.fetch(voterSnapshotPda(pPda, me));
  console.log("VoterSnapshot:", { voter: snap.voter.toBase58(), weight: snap.weight.toString() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
