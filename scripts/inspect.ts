// Diagnostics — read Config + per-role SpendTracker straight from chain, plus
// the validator's current clock.
//
//   GOVERNANCE_MINT=<mint>

import { getProvider, loadProgram, configPda, spendTrackerPda, chainNow } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);

  console.log("=== Config ===");
  const c = await program.account.config.fetch(configPda());
  console.log({
    ownersAuthority: c.ownersAuthority.toBase58(),
    adminAuthority: c.adminAuthority.toBase58(),
    president: c.president.toBase58(),
    financeMinister: c.financeMinister.toBase58(),
    cultureMinister: c.cultureMinister.toBase58(),
    governanceMint: c.governanceMint.toBase58(),
    treasuryMint: c.treasuryMint.toBase58(),
    treasuryTokenAccount: c.treasuryTokenAccount.toBase58(),
    feePool: c.feePool.toBase58(),
    feePosition: c.feePosition.toBase58(),
    quorumExcludedAccount: c.quorumExcludedAccount.toBase58(),
    paused: c.paused,
    votingPeriodSecs: c.votingPeriodSecs.toString(),
    timelockSecs: c.timelockSecs.toString(),
    quorumSpendBps: c.quorumSpendBps.toString(),
    quorumRoleBps: c.quorumRoleBps.toString(),
    quorumParamBps: c.quorumParamBps.toString(),
    financeDailyBps: c.financeDailyBps.toString(),
    financeWeeklyBps: c.financeWeeklyBps.toString(),
    cultureDailyBps: c.cultureDailyBps.toString(),
    cultureWeeklyBps: c.cultureWeeklyBps.toString(),
    payrollPresidentBps: c.payrollPresidentBps.toString(),
    citizenshipThresholdBps: c.citizenshipThresholdBps.toString(),
    milestoneDepositBps: c.milestoneDepositBps.toString(),
    milestoneReserved: c.milestoneReserved.toString(),
    treasurySnapshotAmount: c.treasurySnapshotAmount.toString(),
    treasurySnapshotDay: c.treasurySnapshotDay.toString(),
    nextMilestoneNumber: c.nextMilestoneNumber.toString(),
    proposalCount: c.proposalCount.toString(),
  });

  for (const [label, role] of [
    ["finance", 1],
    ["culture", 2],
  ] as const) {
    console.log(`\n=== SpendTracker (${label}, role ${role}) ===`);
    try {
      const t = await program.account.spendTracker.fetch(spendTrackerPda(role));
      console.log({
        role: t.role,
        dailyWindowStart: t.dailyWindowStart.toString(),
        dailySpent: t.dailySpent.toString(),
        weeklyWindowStart: t.weeklyWindowStart.toString(),
        weeklySpent: t.weeklySpent.toString(),
      });
    } catch {
      console.log("(not created yet)");
    }
  }

  const now = await chainNow(provider.connection);
  console.log("\n=== Validator clock ===");
  console.log({ chainNow: now, human: new Date(now * 1000).toISOString() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
