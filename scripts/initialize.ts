// initialize Config + treasury.
//
//   GOVERNANCE_MINT=<mint>            (required — see scripts/create_mint.ts)
//   OWNERS_AUTHORITY=<squads vault>   (required — posts snapshots, executes proposals)
//   ADMIN_AUTHORITY=<key/multisig>    (required — pause + citizenship threshold)
//   PRESIDENT=<pubkey>                (optional — defaults to the fee payer)
//   PARAMS=test|prod                  (test is rejected on a mainnet RPC)
//
// The fee payer only pays rent; it gets no standing power.

import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  anchor,
  getProvider,
  loadProgram,
  GOVERNANCE_MINT,
  PROGRAM_ID,
  configPda,
  treasuryAta,
  TOKEN_PROGRAM,
  ATA_PROGRAM,
} from "./lib/env";
import { resolveParams } from "./params";

async function main() {
  if (!process.env.OWNERS_AUTHORITY) {
    throw new Error("Set OWNERS_AUTHORITY to the Squads vault pubkey.");
  }
  if (!process.env.ADMIN_AUTHORITY) {
    throw new Error("Set ADMIN_AUTHORITY (break-glass pause + citizenship threshold).");
  }
  const ownersAuthority = new PublicKey(process.env.OWNERS_AUTHORITY);
  const adminAuthority = new PublicKey(process.env.ADMIN_AUTHORITY);

  const provider = getProvider();
  const program = loadProgram(provider);
  const { profile, params, rpcUrl } = resolveParams(provider.connection);

  const president = process.env.PRESIDENT
    ? new PublicKey(process.env.PRESIDENT)
    : provider.wallet.publicKey;

  console.log("Program:", PROGRAM_ID.toBase58());
  console.log("RPC:", rpcUrl || "(from Anchor provider)");
  console.log("Profile:", profile);
  console.log("Config PDA:", configPda().toBase58());
  console.log("Treasury ATA:", treasuryAta().toBase58());
  console.log("owners_authority:", ownersAuthority.toBase58());
  console.log("admin_authority:", adminAuthority.toBase58());
  console.log("President:", president.toBase58());

  const tx = await program.methods
    .initialize(
      ownersAuthority,
      adminAuthority,
      president,
      new anchor.BN(params.votingPeriodSecs),
      new anchor.BN(params.proposalThresholdBps),
      new anchor.BN(params.quorumSpendBps),
      new anchor.BN(params.quorumRoleBps),
      new anchor.BN(params.quorumParamBps),
      new anchor.BN(params.financeDailyBps),
      new anchor.BN(params.financeWeeklyBps),
      new anchor.BN(params.cultureDailyBps),
      new anchor.BN(params.cultureWeeklyBps),
      new anchor.BN(params.timelockSecs),
      new anchor.BN(params.payrollPresidentBps),
      new anchor.BN(params.payrollFinanceBps),
      new anchor.BN(params.payrollCultureBps),
      new anchor.BN(params.citizenshipThresholdBps),
      new anchor.BN(params.milestoneDepositBps),
      new anchor.BN(params.spendCooldownSecs),
      new anchor.BN(params.execFallbackSecs),
      new anchor.BN(params.milestoneGraceSecs)
    )
    .accounts({
      owner: provider.wallet.publicKey,
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      treasury: treasuryAta(),
      tokenProgram: TOKEN_PROGRAM,
      associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\ninitialize tx:", tx);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
