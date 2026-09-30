// A1 — access control & account substitution.  Every attack here SHOULD be rejected (BLOCKED).
// Complements scripts/e2e.ts (which already covers NotOwner, AlreadyVoted, WrongRecipient for SPEND, etc.).
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a1_access.ts
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  makeWorld, group, record, expectBlocked, must, progFor, anchor, NATIVE_MINT, TP, TPT, ATAP, METEORA, COIN, SOL, PROGRAM_ID,
  newFunded, finish, waitChain, chainNow, u64, sleep,
} from "./lib";

async function main() {
  group("A1 access control");
  const w = await makeWorld({ name: "a1", supplyCoins: 1_000_000_000n });
  const A = await w.holder(200_000_000n); // whale (20%)
  const B = await w.holder(60_000_000n); // 6%
  const C = await w.holder(2_000_000n); // 0.2% (below the 1% proposal threshold)
  const atk = await w.holder(0n, 100); // attacker: no coins
  await w.seedTreasury(5n * SOL);
  await w.withPool(300_000_000n, 30n * SOL);
  record("A1.0", "world ready: 1B coins, 30% in a real Meteora pool, 5 SOL in the treasury", "INFO");

  // ---- create_proposal with somebody else's token account (threshold spoof)
  await expectBlocked("A1.1", "create_proposal signed by the attacker but with the WHALE's token account (to fake the 1% threshold)", ["ConstraintRaw", "2003"], async () => {
    const id = (await w.cfg()).proposalCount;
    await progFor(atk).methods.createProposal(0, atk.publicKey, new anchor.BN(1000), 0, "steal")
      .accounts(await w.createAccts(atk.publicKey, w.ata(A.publicKey), w.proposalPda(id))).rpc();
  });
  await expectBlocked("A1.2", "create_proposal by a holder below the threshold (0.2% < 1%)", "BelowThreshold", async () => {
    const id = (await w.cfg()).proposalCount;
    await progFor(C).methods.createProposal(0, C.publicKey, new anchor.BN(1000), 0, "x")
      .accounts(await w.createAccts(C.publicKey, w.ata(C.publicKey), w.proposalPda(id))).rpc();
  });
  await expectBlocked("A1.3", "create_proposal passing a fake 'pool vault' (whale's account) as quorum_excluded", "ExcludedAccountMissing", async () => {
    const id = (await w.cfg()).proposalCount;
    const a: any = await w.createAccts(w.me, w.myAta, w.proposalPda(id));
    a.quorumExcluded = w.ata(A.publicKey);
    await w.program.methods.createProposal(0, w.me, new anchor.BN(1000), 0, "spoof").accounts(a).rpc();
  });

  // ---- vote / snapshot spoofing
  const p = await w.propose(0, A.publicKey, SOL / 100n, 0, "spend for A");
  await w.snapshot(p.id, p.pPda, A.publicKey);
  await expectBlocked("A1.4", "attacker votes using the WHALE's snapshot (signs as himself, passes A's snapshot PDA)", ["ConstraintSeeds", "2006"], () =>
    w.vote(atk, p.id, p.pPda, true, A.publicKey));
  await expectBlocked("A1.5", "owner-side: snapshot for the attacker's key but reading the WHALE's token account", "SnapshotAccountMismatch", () =>
    w.snapshot(p.id, p.pPda, atk.publicKey, w.payer, w.ata(A.publicKey)));
  await expectBlocked("A1.6", "vote by a wallet that has NO snapshot", ["AccountNotInitialized", "3012"], () => w.vote(atk, p.id, p.pPda, true));

  // ---- role / admin gates
  await expectBlocked("A1.7", "claim_salary by a random wallet", "NotEligibleForPayroll", () =>
    progFor(atk).methods.claimSalary().accounts({ claimant: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, payrollClaim: w.payrollPda(atk.publicKey), treasury: w.treasury, claimantTokenAccount: w.tAta(atk.publicKey), tokenProgram: TPT, systemProgram: SystemProgram.programId }).rpc());
  for (const role of [1, 2]) {
    await expectBlocked(`A1.8.${role}`, `minister_spend(role=${role}) by a random wallet`, "NotMinister", () =>
      progFor(atk).methods.ministerSpend(role, new anchor.BN(1), "grab").accounts({ minister: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, spendTracker: w.trackerPda(role), treasury: w.treasury, recipientTokenAccount: w.tAta(atk.publicKey), tokenProgram: TPT, systemProgram: SystemProgram.programId }).rpc());
  }
  await expectBlocked("A1.9", "minister_spend with an invalid role byte (0 / 7)", "NotMinister", () =>
    progFor(atk).methods.ministerSpend(7, new anchor.BN(1), "grab").accounts({ minister: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, spendTracker: w.trackerPda(7), treasury: w.treasury, recipientTokenAccount: w.tAta(atk.publicKey), tokenProgram: TPT, systemProgram: SystemProgram.programId }).rpc());
  await expectBlocked("A1.10", "set_pause by a non-admin", "NotAdmin", () => progFor(atk).methods.setPause(true).accounts({ admin: atk.publicKey, config: w.configPda }).rpc());
  await expectBlocked("A1.11", "set_citizenship_threshold by a non-admin", "NotAdmin", () => progFor(atk).methods.setCitizenshipThreshold(new anchor.BN(0)).accounts({ admin: atk.publicKey, config: w.configPda }).rpc());
  await expectBlocked("A1.12", "setup_milestone_fund called again / by a non-owner", ["NotOwner", "already in use", "0x0"], () =>
    progFor(atk).methods.setupMilestoneFund().accounts({ owner: atk.publicKey, config: w.configPda, treasuryMint: NATIVE_MINT, milestoneFund: w.milestoneFundPda, tokenProgram: TPT, systemProgram: SystemProgram.programId }).rpc());
  await expectBlocked("A1.13", "create_milestone by a non-owner", "NotOwner", async () => {
    const n = (await w.cfg()).nextMilestoneNumber;
    await progFor(atk).methods.createMilestone().accounts({ owner: atk.publicKey, config: w.configPda, milestoneRecord: w.milestonePda(n), systemProgram: SystemProgram.programId }).rpc();
  });
  await expectBlocked("A1.14", "re-initialize an already initialised state (take over an existing Config)", ["already in use", "0x0"], () =>
    progFor(atk).methods.initialize(atk.publicKey, atk.publicKey, atk.publicKey, new anchor.BN(1), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(0), new anchor.BN(1), new anchor.BN(0))
      .accounts({ owner: atk.publicKey, governanceMint: w.mint.publicKey, treasuryMint: NATIVE_MINT, config: w.configPda, treasury: w.treasury, tokenProgram: TPT, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId }).rpc());

  // ---- claim_pool_fees redirection variants (destination hard-wired)
  const fakeProg = Keypair.generate().publicKey;
  await expectBlocked("A1.15", "claim_pool_fees with the attacker's 'token A' fee account", ["ConstraintAssociated", "ConstraintTokenOwner", "2009", "3014"], async () =>
    progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { feeAAccount: w.ata(atk.publicKey) })).rpc());
  await expectBlocked("A1.16", "claim_pool_fees with a FAKE Meteora program (to get the Config PDA's signature on an arbitrary CPI)", ["ConstraintAddress", "2012"], async () =>
    progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { meteoraProgram: fakeProg })).rpc());
  await expectBlocked("A1.17", "claim_pool_fees with a different pool account", ["ConstraintAddress", "2012"], async () =>
    progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { pool: w.treasury })).rpc());
  await expectBlocked("A1.18", "claim_pool_fees with a different position / NFT account", ["ConstraintAddress", "2012"], async () =>
    progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { positionNftAccount: w.tAta(atk.publicKey) })).rpc());
  await expectBlocked("A1.19", "claim_pool_fees where the attacker swaps in HIS OWN wSOL account as the treasury", ["ConstraintAddress", "2012"], async () =>
    progFor(atk).methods.claimPoolFees().accounts(await w.claimFeesAccts(atk.publicKey, { treasury: w.tAta(atk.publicKey) })).rpc());
  await expectBlocked("A1.20", "register_pool by the attacker (already registered + not owner)", ["NotOwner", "PoolAlreadyRegistered"], async () => {
    const c = await w.cfg();
    await progFor(atk).methods.registerPool().accounts({ owner: atk.publicKey, config: w.configPda, governanceMint: w.mint.publicKey, pool: c.feePool, position: c.feePosition, positionNftAccount: c.feePositionNftAccount, feeAAccount: w.feeAAccount, governanceTokenProgram: TP, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId }).rpc();
  });

  // ---- milestone payout redirection
  await w.fundMilestoneDirect(2n * SOL);
  const ms = await w.createMilestone();
  await w.msSnap(ms.n, ms.m, A.publicKey);
  await w.msSnap(ms.n, ms.m, B.publicKey);
  await w.msFinalize(ms.n, ms.m);
  const atkBefore = await w.tbal(w.tAta(atk.publicKey));
  await expectBlocked("A1.21", "claim_milestone: attacker pushes WHALE's payout into HIS OWN wSOL account", "WrongRecipient", () =>
    w.msClaim(ms.n, ms.m, A.publicKey, atk, w.tAta(atk.publicKey)));
  const aBefore = await w.tbal(w.tAta(A.publicKey));
  await must("A1.22", "claim_milestone: a stranger pays WHALE's share to the whale's own account (allowed by design)", () => w.msClaim(ms.n, ms.m, A.publicKey, atk));
  const aAfter = await w.tbal(w.tAta(A.publicKey));
  const atkAfter = await w.tbal(w.tAta(atk.publicKey));
  record("A1.23", "…and the attacker received nothing from that call", atkAfter === atkBefore && aAfter > aBefore ? "BLOCKED" : "EXPLOITABLE", `attacker wSOL ${atkBefore}→${atkAfter}, whale ${aBefore}→${aAfter}`);
  await expectBlocked("A1.24", "claim_milestone a second time for the same holder", "AlreadyClaimedMilestone", () => w.msClaim(ms.n, ms.m, A.publicKey, atk));
  await expectBlocked("A1.25", "post_milestone_snapshot after the milestone is finalized", "MilestoneFinalized", () => w.msSnap(ms.n, ms.m, C.publicKey));

  // ---- vote after the deadline, execute before it
  await waitChain((await w.deadlineOf(p.pPda)) + 1);
  await expectBlocked("A1.26", "vote after the voting period ended", "ProposalNotActive", () => w.vote(A, p.id, p.pPda, true));
  // ---- type-6 (milestone deposit) with an attacker-controlled destination
  await w.waitExecutable(p.pPda);
  const dep = await w.propose(6, w.me, SOL / 20n, 0, "deposit");
  await w.snapshot(dep.id, dep.pPda, A.publicKey);
  await w.snapshot(dep.id, dep.pPda, B.publicKey);
  await w.vote(A, dep.id, dep.pPda, true);
  await w.vote(B, dep.id, dep.pPda, true);
  await w.waitExecutable(dep.pPda);
  await expectBlocked("A1.27", "execute the milestone-deposit proposal with the ATTACKER's wSOL account as 'milestone fund'", "MilestoneFundMissing", async () => {
    await progFor(w.payer).methods.executeProposal(new anchor.BN(dep.id.toString())).accounts({
      executor: w.me, config: w.configPda, governanceMint: w.mint.publicKey, treasuryMint: NATIVE_MINT, proposal: dep.pPda, treasury: w.treasury,
      recipientTokenAccount: null, milestoneFund: w.tAta(atk.publicKey), quorumExcluded: await w.excl(), tokenProgram: TPT,
    }).rpc();
  });
  await expectBlocked("A1.28", "execute with the pool vault OMITTED (to shrink the quorum base)", "ExcludedAccountMissing", () =>
    w.execute(dep.id, { milestoneFund: true, excludedOverride: null }));
  await must("A1.29", "control: the same proposal executes with the right accounts", () => w.execute(dep.id, { milestoneFund: true }));

  finish("audit/results_a1.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
