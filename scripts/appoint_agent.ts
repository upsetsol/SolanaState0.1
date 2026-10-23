// Appoint a finance or culture minister by the OWNER's vote (on Test 2 the owner is the only voter) and carry it out.
// Safe to run again: it finds the proposal that already exists (same type + same wallet, not yet executed) and
// continues it; it never creates a duplicate.
//
//   npx ts-node scripts/appoint_agent.ts create  <finance|culture> <wallet>   create + enrol the owner + open the voting + vote "for"
//   npx ts-node scripts/appoint_agent.ts execute <finance|culture> <wallet>   wait until the voting is over, then execute
//   CONFIRM=yes   to really send (without it: checks and plan only)
//
//   GOVERNANCE_MINT, ANCHOR_PROVIDER_URL and ANCHOR_WALLET (= the owner's key) are set by scripts/appoint_agent.sh.

import { PublicKey } from "@solana/web3.js";
import {
  getProvider, loadProgram, configPda, proposalPda, voterSnapshotPda,
  createProposal, postSnapshot, openVoting, castVote, executeProposal, chainNow, waitUntilChainTime,
} from "./lib/env";

const [mode, roleName, targetText] = process.argv.slice(2);
const TYPES: Record<string, number> = { finance: 2, culture: 3 };
const when = (s: number) => new Date(s * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";

async function main() {
  if (!["create", "execute"].includes(mode) || !(roleName in TYPES) || !targetText) {
    throw new Error("usage: appoint_agent.ts <create|execute> <finance|culture> <wallet address>");
  }
  const type = TYPES[roleName];
  const target = new PublicKey(targetText);
  const send = process.env.CONFIRM === "yes";

  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;
  const cfg: any = await program.account.config.fetch(configPda());
  const now0 = await chainNow(provider.connection);

  const currentHolder: PublicKey = type === 2 ? cfg.financeMinister : cfg.cultureMinister;
  console.log(`state    : ${configPda().toBase58()}  (voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s)`);
  console.log(`wallet   : ${me.toBase58()}  (must be the owner: ${cfg.ownersAuthority.toBase58()})`);
  console.log(`role     : ${roleName} minister, now held by ${currentHolder.equals(PublicKey.default) ? "(nobody)" : currentHolder.toBase58()}`);
  console.log(`new holder: ${target.toBase58()}`);
  if (!me.equals(cfg.ownersAuthority)) throw new Error("the signing wallet is not the state owner");
  if (currentHolder.equals(target)) { console.log("\nALREADY DONE: this wallet already holds the role."); return; }
  const other: PublicKey = type === 2 ? cfg.cultureMinister : cfg.financeMinister;
  if (target.equals(cfg.president) || target.equals(other)) throw new Error("a role must be held by a distinct address: this wallet already holds another role");

  // the proposal that may already exist (same type + same wallet, not executed); the newest one wins
  let found: { id: number; p: any } | null = null;
  const count = Number(cfg.proposalCount.toString());
  for (let i = 0; i < count; i++) {
    const p: any = await program.account.proposal.fetchNullable(proposalPda(i));
    if (p && p.proposalType === type && p.target.equals(target) && !p.executed) found = { id: i, p };
  }

  if (mode === "create") {
    if (!found) {
      console.log("\nplan     : create the proposal, enrol the owner as the voter, open the voting, vote FOR");
      if (!send) { console.log("DRY RUN - nothing sent. Run again with CONFIRM=yes."); return; }
      const created = await createProposal(program, provider, { type: type as 2 | 3, target, reason: `Appoint ${roleName} minister (agent wallet)` });
      console.log(`created proposal #${created.id.toString()}`);
      found = { id: Number(created.id.toString()), p: await program.account.proposal.fetch(proposalPda(created.id)) };
    } else {
      console.log(`\nproposal #${found.id} for this wallet already exists - continuing it (no duplicate is created)`);
      if (!send) { console.log("DRY RUN - nothing sent. Run again with CONFIRM=yes."); return; }
    }
    const id = found.id;
    let p: any = await program.account.proposal.fetch(proposalPda(id));
    const snapPda = voterSnapshotPda(proposalPda(id), me);
    let snap: any = await program.account.voterSnapshot.fetchNullable(snapPda);
    if (!p.votingOpen) {
      if (!snap) { await postSnapshot(program, provider, id, me); console.log("owner enrolled as the voter"); }
      await openVoting(program, provider, id);
      console.log("voting opened");
      p = await program.account.proposal.fetch(proposalPda(id));
      snap = await program.account.voterSnapshot.fetchNullable(snapPda);
    }
    if (snap && !snap.consumed) { await castVote(program, provider, id, true); console.log("voted FOR"); }
    else if (snap && snap.consumed) console.log("the owner has already voted");
    p = await program.account.proposal.fetch(proposalPda(id));
    const deadline = Number(p.deadline.toString());
    const unlock = deadline + Number(cfg.timelockSecs.toString());
    console.log(`\nDONE: proposal #${id}. Voting ends ${when(deadline)}; it can be executed from ${when(unlock)}.`);
    console.log(`NEXT (after that time):  CONFIRM=yes bash scripts/appoint_agent.sh execute ${roleName} ${target.toBase58()}`);
    return;
  }

  // mode === "execute"
  if (!found) throw new Error("no open proposal for this wallet - run `create` first");
  const id = found.id;
  const p: any = await program.account.proposal.fetch(proposalPda(id));
  if (!p.votingOpen) throw new Error(`proposal #${id} exists but its voting was never opened - run \`create\` again`);
  const unlock = Number(p.deadline.toString()) + Number(cfg.timelockSecs.toString());
  console.log(`proposal #${id}: for ${p.votesFor.toString()} / against ${p.votesAgainst.toString()}; executable from ${when(unlock)} (chain time now ${when(now0)})`);
  if (!send) { console.log("DRY RUN - nothing sent. Run again with CONFIRM=yes."); return; }
  await waitUntilChainTime(provider.connection, unlock + 2);
  const sig = await executeProposal(program, provider, id);
  console.log("executed, tx", sig);
  const after: any = await program.account.config.fetch(configPda());
  const holder: PublicKey = type === 2 ? after.financeMinister : after.cultureMinister;
  if (!holder.equals(target)) throw new Error("executed, but the role did not change - check the proposal");
  console.log(`\nDONE: ${target.toBase58()} is now the ${roleName} minister.`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***"));
  process.exit(1);
});
