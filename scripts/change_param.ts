// Propose a parameter change (CHANGE_PARAM, type 4). Values are bounds-checked
// at execution time (see check_param_bounds in lib.rs).
//
//   GOVERNANCE_MINT=<mint>
//   PARAM_KEY=<0..13>   0 voting_period 1 threshold 2/3/4 quorums
//                       5/6 finance daily/weekly 7/8 culture daily/weekly
//                       9 timelock 10/11/12 payroll pres/finance/culture
//                       13 spend_cooldown_secs
//   VALUE=<number>

import { getProvider, loadProgram, createProposal, postSnapshot, castVote } from "./lib/env";

async function main() {
  const paramKey = Number(process.env.PARAM_KEY ?? "5");
  const value = process.env.VALUE ?? "300";

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const { id } = await createProposal(program, provider, {
    type: 4,
    target: me, // unused for CHANGE_PARAM
    amount: value,
    paramKey,
    reason: `Change param ${paramKey} -> ${value}`,
  });
  console.log(`create_proposal (ChangeParam key=${paramKey} value=${value}) id:`, id.toString());

  await postSnapshot(program, provider, id, me);
  await castVote(program, provider, id, true);
  console.log("snapshot + vote ok");
  console.log(`\nAfter deadline + timelock: npx ts-node scripts/execute_proposal.ts ${id}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
