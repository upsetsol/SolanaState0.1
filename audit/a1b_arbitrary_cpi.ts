// A1b — the classic worst Solana bug: "arbitrary CPI".  If an instruction that signs as the Config PDA (owner of the
// treasury / milestone fund) accepted ANY program in the `token_program` slot, a stranger could hand it a malicious
// program and receive the Config PDA's signature.  Every attempt here SHOULD be rejected by Anchor's program-id check.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a1b_arbitrary_cpi.ts
import { SystemProgram, PublicKey } from "@solana/web3.js";
import { makeWorld, group, expectBlocked, progFor, anchor, NATIVE_MINT, TP, SOL, finish } from "./lib";

async function main() {
  group("A1b arbitrary CPI / fake programs");
  const w = await makeWorld({ name: "a1b" });
  const A = await w.holder(200_000_000n, 10);
  const atk = await w.holder(0n, 50);
  await w.seedTreasury(2n * SOL);
  await w.withPool(300_000_000n, 30n * SOL);
  await w.fundMilestoneDirect(SOL);
  const ms = await w.createMilestone();
  await w.msSnap(ms.n, ms.m, A.publicKey);
  await w.msFinalize(ms.n, ms.m);
  // an executable program that is NOT a token program (the System program) plays the "malicious program"
  const FAKE = SystemProgram.programId;
  const CODES = ["InvalidProgramId", "3008", "InvalidProgramExecutable", "IncorrectProgramId"];

  await expectBlocked("A1b.1", "claim_milestone (anyone can call it) with a fake program in the token_program slot", CODES, async () => {
    await progFor(atk).methods.claimMilestone(new anchor.BN(ms.n.toString()), A.publicKey).accounts({ ...w.claimAccts(ms.m, A.publicKey, atk.publicKey), tokenProgram: FAKE }).rpc();
  });
  await expectBlocked("A1b.2", "claim_salary with a fake token program", CODES, async () => {
    await progFor(atk).methods.claimSalary(0).accounts({ claimant: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, payrollClaim: w.payrollPda(0), treasury: w.treasury, claimantTokenAccount: w.tAta(atk.publicKey), tokenProgram: FAKE, systemProgram: SystemProgram.programId }).rpc();
  });
  await expectBlocked("A1b.3", "minister_spend with a fake token program", CODES, async () => {
    await progFor(atk).methods.ministerSpend(1, new anchor.BN(1), "x").accounts({ minister: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, spendTracker: w.trackerPda(1), treasury: w.treasury, recipientTokenAccount: w.tAta(atk.publicKey), tokenProgram: FAKE, systemProgram: SystemProgram.programId }).rpc();
  });
  await expectBlocked("A1b.4", "claim_pool_fees with a fake program as token_b_program", CODES, async () => {
    await progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { tokenBProgram: FAKE })).rpc();
  });
  await expectBlocked("A1b.5", "claim_pool_fees with a fake program as token_a_program", CODES.concat(["ConstraintAssociated", "ConstraintTokenOwner", "AccountOwnedByWrongProgram"]), async () => {
    await progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { tokenAProgram: FAKE })).rpc();
  });
  await expectBlocked("A1b.6", "claim_pool_fees with the WRONG token program (Token-2022 for the wSOL side)", ["InvalidProgramId", "ConstraintAssociated", "ConstraintTokenOwner", "AccountOwnedByWrongProgram", "IncorrectProgramId", "custom program error", "Constraint"], async () => {
    await progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { tokenBProgram: TP })).rpc();
  });
  finish("audit/results_a1b.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
