// Precise timelock test: creates a CHANGE_PARAM proposal, votes, then polls
// the VALIDATOR clock and hits the boundary exactly — just after the deadline
// (expect TimelockNotElapsed) and just after deadline + timelock (expect
// success). The script waits on its own; may take a few minutes.
//
//   GOVERNANCE_MINT=<mint>

import {
  getProvider,
  loadProgram,
  createProposal,
  postSnapshot,
  castVote,
  executeProposal,
  proposalPda,
  configPda,
  waitUntilChainTime,
} from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 4,
    target: me,
    amount: "70",
    paramKey: 7, // culture_daily_bps
    reason: "Precise timelock test",
  });
  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);

  const proposal = await program.account.proposal.fetch(proposalPda(id));
  const cfg = await program.account.config.fetch(configPda());
  const deadline = Number(proposal.deadline.toString());
  const timelock = Number(cfg.timelockSecs.toString());
  console.log(`deadline ${deadline}, unlock at ${deadline + timelock}`);

  console.log("\nStep 1 — wait for the voting deadline only...");
  await waitUntilChainTime(provider.connection, deadline + 2);
  try {
    await executeProposal(program, provider, id);
    console.log("❌ PROBLEM: executed before the timelock");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("failed with:", msg, msg === "TimelockNotElapsed" ? "✅ expected" : "❌ unexpected");
  }

  console.log("\nStep 2 — wait for the timelock...");
  await waitUntilChainTime(provider.connection, deadline + timelock + 2);
  try {
    const tx = await executeProposal(program, provider, id);
    console.log("✅ executed, tx:", tx);
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("❌ unexpected failure:", msg);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
