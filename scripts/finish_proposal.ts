// Finishes a proposal that was CREATED but not completed (the network dropped in the middle of scripts/change_param.ts, appoint_*.ts, ...):
// posts the owner's snapshot if it is missing, opens the voting if it is not open, casts the vote "for" if it is not cast. Every step is skipped when it is already done.
//
//   GOVERNANCE_MINT=<mint>  PROPOSAL_ID=<id>      (the wallet is the owner and the voter)
//   EXPECT_TYPE=<0..6>  EXPECT_PARAM_KEY=<0..14>   optional safety: refuse if the proposal is not what you think it is
import { getProvider, loadProgram, postSnapshot, openVoting, castVote, proposalPda, voterSnapshotPda } from "./lib/env";

async function main() {
  const id = process.env.PROPOSAL_ID;
  if (id === undefined || id === "") throw new Error("set PROPOSAL_ID=<id>");
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;
  const pda = proposalPda(id);
  const p: any = await program.account.proposal.fetch(pda).catch(() => null);
  if (!p) throw new Error(`proposal #${id} does not exist`);
  console.log(`proposal #${id}: type ${p.proposalType}, param key ${p.paramKey}, voting open: ${p.votingOpen}, executed: ${p.executed}`);
  if (process.env.EXPECT_TYPE !== undefined && process.env.EXPECT_TYPE !== "" && Number(process.env.EXPECT_TYPE) !== Number(p.proposalType)) throw new Error(`proposal #${id} has type ${p.proposalType}, expected ${process.env.EXPECT_TYPE}`);
  if (Number(p.proposalType) === 4 && process.env.EXPECT_PARAM_KEY !== undefined && process.env.EXPECT_PARAM_KEY !== "" && Number(process.env.EXPECT_PARAM_KEY) !== Number(p.paramKey)) throw new Error(`proposal #${id} changes parameter ${p.paramKey}, expected ${process.env.EXPECT_PARAM_KEY}`);
  if (p.executed) { console.log("already executed - nothing to do"); return; }

  const snapPda = voterSnapshotPda(pda, me);
  let snap: any = await program.account.voterSnapshot.fetch(snapPda).catch(() => null);
  if (!p.votingOpen) {
    if (!snap) { console.log("post_voter_snapshot tx:", await postSnapshot(program, provider, id, me)); snap = await program.account.voterSnapshot.fetch(snapPda).catch(() => null); }
    else console.log("snapshot was already posted");
    console.log("open_voting tx:", await openVoting(program, provider, id));
  } else console.log("voting was already open");
  snap = snap ?? (await program.account.voterSnapshot.fetch(snapPda).catch(() => null));
  if (!snap) throw new Error("the voting is open but this wallet has no snapshot - it cannot vote on this proposal");
  if (snap.consumed) console.log("the vote was already cast");
  else console.log("vote tx:", await castVote(program, provider, id, true));
  const after: any = await program.account.proposal.fetch(pda);
  console.log(`DONE: proposal #${id} - voting open: ${after.votingOpen}, votes for ${after.votesFor.toString()}, against ${after.votesAgainst.toString()}, deadline ${new Date(Number(after.deadline.toString()) * 1000).toISOString()}`);
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
