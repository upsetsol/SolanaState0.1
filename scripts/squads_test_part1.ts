// Part 1: create a Squads multisig (2-of-2) and open a governance proposal to
// move owners_authority to its vault (CHANGE_OWNERS_AUTHORITY, type 5).
//
//   GOVERNANCE_MINT=<mint>
//   SECOND_MEMBER=~/holder-b.json   second multisig member's keypair

import * as multisig from "@sqds/multisig";
import {
  Keypair,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import * as os from "os";
import {
  anchor,
  getProvider,
  loadProgram,
  loadKeypair,
  createProposal,
  postSnapshot,
  castVote,
} from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const connection = provider.connection;
  const me = provider.wallet.publicKey;

  const creator = loadKeypair(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
  const secondMember = loadKeypair(process.env.SECOND_MEMBER || `${os.homedir()}/holder-b.json`);

  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda
  );

  const sig1 = await multisig.rpc.multisigCreateV2({
    connection,
    createKey,
    creator,
    multisigPda,
    configAuthority: null,
    timeLock: 0,
    members: [
      { key: creator.publicKey, permissions: multisig.types.Permissions.all() },
      { key: secondMember.publicKey, permissions: multisig.types.Permissions.all() },
    ],
    threshold: 2,
    rentCollector: null,
    treasury: programConfig.treasury,
    sendOptions: { skipPreflight: true },
  });
  await connection.confirmTransaction(sig1, "confirmed");
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  console.log("multisig:", multisigPda.toBase58(), "vault:", vaultPda.toBase58());

  // fund the vault so it can pay rent for snapshot PDAs later
  const fundTx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: vaultPda,
          lamports: 0.05 * LAMPORTS_PER_SOL,
        }),
      ],
    }).compileToV0Message()
  );
  fundTx.sign([creator]);
  await connection.sendTransaction(fundTx);

  const { id } = await createProposal(program, provider, {
    type: 5,
    target: vaultPda,
    reason: "Move owners_authority to Squads vault",
  });
  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);

  console.log("\n=== SAVE THESE ===");
  console.log("MULTISIG=" + multisigPda.toBase58());
  console.log("VAULT=" + vaultPda.toBase58());
  console.log("CHANGE_PROPOSAL_ID=" + id.toString());
  console.log(
    `\nAfter deadline + timelock: MULTISIG=... VAULT=... CHANGE_PROPOSAL_ID=${id} npx ts-node scripts/squads_test_part2.ts`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
