// A9 — the code that v4.1 ADDED: clean-up instructions (close_proposal, close_voter_snapshot) and the per-role salary record.
// New code is new attack surface, so it is attacked like everything else: who can close what, when, where the rent goes,
// and whether a change of the finance minister still pays a second salary for the same day (finding 16 of the v4 report).
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a9_cleanup_payroll.ts
import { SystemProgram } from "@solana/web3.js";
import { makeWorld, group, record, recordFixed, attempt, expectBlocked, progFor, anchor, NATIVE_MINT, TPT, SOL, finish, conn } from "./lib";

async function main() {
  group("A9 v4.1 clean-up + payroll");
  const w = await makeWorld({ name: "a9", params: { cooldown: 0, vote: 12, timelock: 5, quorumRoleBps: 1000, quorumSpendBps: 300 } });
  const A = await w.holder(200_000_000n, 20); // creator of the test proposal, 20%
  const S = await w.holder(0n, 20); // a stranger with some SOL and no coins
  await w.seedTreasury(5n * SOL);
  const bn = (x: any) => new anchor.BN(x.toString());
  const lam = (n: bigint) => `${(Number(n) / 1e9).toFixed(6)} SOL`;

  const closeProposal = (by: any, id: any, pPda: any, creator: any) =>
    progFor(by).methods.closeProposal(bn(id)).accounts({ caller: by.publicKey, config: w.configPda, proposal: pPda, creator }).rpc();
  const closeSnap = (by: any, id: any, pPda: any, voter: any, ownerRefund: any) =>
    progFor(by).methods.closeVoterSnapshot(bn(id), voter).accounts({ caller: by.publicKey, config: w.configPda, proposal: pPda, voterSnapshot: w.snapPda(pPda, voter), ownerRefund }).rpc();

  // ---- the proposal that the clean-up attacks are run on: created by A, enrolled A + deployer, passes
  const p = await w.propose(0, w.me, 1000n, 0, "clean-up test", A);
  await w.snapshot(p.id, p.pPda, A.publicKey);
  await w.snapshot(p.id, p.pPda, w.me);

  await expectBlocked("A9.1", "a stranger closes a proposal that is still ENROLLING (voting not open yet) to grief the creator", "NotFinishedYet", async () => {
    await closeProposal(S, p.id, p.pPda, A.publicKey);
  });
  await expectBlocked("A9.2", "a stranger closes a voter snapshot while the proposal is still enrolling (to strip a voter before the vote)", "NotFinishedYet", async () => {
    await closeSnap(S, p.id, p.pPda, A.publicKey, w.me);
  });

  await w.openVoting(p.id);
  await expectBlocked("A9.3", "a stranger closes a proposal while its voting is running", "NotFinishedYet", async () => {
    await closeProposal(S, p.id, p.pPda, A.publicKey);
  });
  await expectBlocked("A9.4", "a stranger closes a voter's snapshot while the voting is running (to keep that voter from voting)", "NotFinishedYet", async () => {
    await closeSnap(S, p.id, p.pPda, A.publicKey, w.me);
  });
  await w.vote(A, p.id, p.pPda, true);
  await w.vote(w.payer, p.id, p.pPda, true);
  await w.waitExecutable(p.pPda);
  const ex = await attempt(() => w.execute(p.id, { recipient: w.tAta(w.me) }));
  record("A9.5", "control: the proposal passes and executes", ex.ok ? "OK" : "ERROR", ex.ok ? "" : ex.err.slice(0, 200));

  await expectBlocked("A9.6", "rent theft: a stranger closes the finished proposal but names HIMSELF as the creator to receive the rent", "ConstraintHasOne", async () => {
    await closeProposal(S, p.id, p.pPda, S.publicKey);
  });
  await expectBlocked("A9.7", "rent theft: a stranger closes a snapshot after the vote but names HIMSELF as the owner to receive the rent", "ConstraintAddress", async () => {
    await closeSnap(S, p.id, p.pPda, A.publicKey, S.publicKey);
  });

  // the legitimate clean-up: anyone may do it, the rent goes back to whoever paid it
  {
    const aBefore = BigInt(await conn.getBalance(A.publicKey, "confirmed"));
    const ownerBefore = BigInt(await conn.getBalance(w.me, "confirmed"));
    const sBefore = BigInt(await conn.getBalance(S.publicKey, "confirmed"));
    const r1 = await attempt(() => closeSnap(S, p.id, p.pPda, A.publicKey, w.me));
    const r2 = await attempt(() => closeSnap(S, p.id, p.pPda, w.me, w.me));
    const ownerGot = BigInt(await conn.getBalance(w.me, "confirmed")) - ownerBefore;
    const r3 = await attempt(() => closeProposal(S, p.id, p.pPda, A.publicKey));
    const aGot = BigInt(await conn.getBalance(A.publicKey, "confirmed")) - aBefore;
    const sDelta = BigInt(await conn.getBalance(S.publicKey, "confirmed")) - sBefore;
    const ok = r1.ok && r2.ok && r3.ok && ownerGot > 0n && aGot > 0n && sDelta < 0n;
    record("A9.8", "control: a stranger cleans up correctly — the rent goes back to the owner (2 snapshots) and the creator (proposal); the stranger only pays the fees", ok ? "OK" : "ERROR",
      `snapshots closed=${r1.ok && r2.ok}, proposal closed=${r3.ok}; owner +${lam(ownerGot)}, creator +${lam(aGot)}, stranger ${lam(sDelta)}${ok ? "" : " " + (r1.err || r2.err || r3.err).slice(0, 160)}`);
    await expectBlocked("A9.9", "a closed proposal cannot be executed again", ["AccountNotInitialized", "3012", "AccountOwnedByWrongProgram"], async () => {
      await w.execute(p.id, { recipient: w.tAta(w.me) });
    });
  }

  // ---- the salary record is per ROLE (v4: per wallet → a change of minister paid a second salary for the same day)
  {
    // the record is per role and the rule is "at least 24 h since the last claim of this role"
    const appoint = async (type: number, who: any, label: string) => {
      const q = await w.propose(type, who.publicKey, 0, 0, label);
      await w.snapshot(q.id, q.pPda, w.me);
      await w.snapshot(q.id, q.pPda, A.publicKey);
      await w.openVoting(q.id);
      await w.vote(w.payer, q.id, q.pPda, true);
      await w.waitExecutable(q.pPda);
      await w.execute(q.id);
    };
    const claim = (kp: any, role: number) =>
      progFor(kp).methods.claimSalary(role).accounts({
        claimant: kp.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, payrollClaim: w.payrollPda(role), treasury: w.treasury,
        claimantTokenAccount: w.tAta(kp.publicKey), tokenProgram: TPT, systemProgram: SystemProgram.programId,
      }).rpc();
    const F1 = await w.holder(0n, 5);
    const F2 = await w.holder(0n, 5);
    await appoint(2, F1, "appoint F1 finance minister");
    const c1 = await attempt(() => claim(F1, 1));
    record("A9.10", "control: the first finance minister claims today's salary", c1.ok ? "OK" : "ERROR", c1.ok ? "" : c1.err.slice(0, 200));
    await appoint(2, F2, "replace the finance minister with F2");
    const c2 = await attempt(() => claim(F2, 1));
    recordFixed("A9.11", "the NEW finance minister claims a salary within 24 h of the previous minister's claim for the same role (finding 16 of the v4 report: a second salary for the same day)", c2.ok,
      c2.ok ? "a second salary was paid for the same day" : `refused: ${/PayrollTooSoon/.test(c2.err) ? "PayrollTooSoon" : c2.err.slice(0, 160)}`);
    await expectBlocked("A9.12", "a finance minister claims with the CULTURE role byte (2) to get a second payout", "NotEligibleForPayroll", async () => {
      await claim(F2, 2);
    });
    await expectBlocked("A9.13", "the REPLACED minister (F1) still tries to claim the finance salary", "NotEligibleForPayroll", async () => {
      await claim(F1, 1);
    });
  }

  finish("audit/results_a9.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
