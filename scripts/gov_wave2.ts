// "WAVE 2" of the governance checks on the live Test 2 state (the windows are short after wave 1: vote 300 s, timelock 0, pause between spends 0).
// One entry, several steps (each one is safe to run again: it looks at the chain first and does only what is missing):
//   prep     helper wallets (citizen, test president), a little SOL for their fees, 5 000 000 coins to the citizen, the owner's wSOL account
//   money    salaries of the three roles; minister spends inside the daily limit and the refusal above it; pause on/off (payouts refused, fee collection still works); a full milestone cycle with payouts
//   votes    six votes at once: spend with two voters (for + against), a rejected one, a no-quorum one, president -> test wallet, a spend for the president's fallback, president back
//   execute  refusals of the contract (not the owner, wrong recipient, rejected, no quorum), the owner executes what passed, the test president executes after the fallback time, the president returns
//   cleanup  closes executed proposals and finished voter snapshots (the deposits come back)
//   status   read-only overview
// Run through scripts/gov_wave2.sh (it sets the network and the wallets). Without CONFIRM=yes a step only prints its plan.
// Every transaction is listed in the journal ~/gov-wave2.log, what has been done in ~/gov-wave2.state.json.

import * as fs from "fs";
import { PublicKey, SystemProgram, Transaction, Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, unpackAccount, getMint } from "@solana/spl-token";
import { spawnSync } from "child_process";
import {
  anchor, getProvider, loadProgram, GOVERNANCE_MINT, TOKEN_PROGRAM, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM,
  configPda, treasuryAta, treasuryAtaOf, ata, proposalPda, voterSnapshotPda, spendTrackerPda, payrollPda, milestonePda, milestoneSnapPda, milestoneFundPda,
  excludedAccountOf, chainNow,
} from "./lib/env";
import { CONFIRM, STATE_FILE, LOG_FILE, State, loadState, saveState, walletFile, createWalletFile, log, tx, pass, fail, note, results, expectRefused, summary } from "./lib/gov2";

// ---------- amounts (raw units of the treasury asset: lamports of wSOL; coins in whole units) ----------
const TOPUP: Record<string, bigint> = { "finance-minister": 10_000_000n, "culture-minister": 10_000_000n, citizen: 5_000_000n, "president-test": 5_000_000n };
const CITIZEN_COINS = 5_000_000n;      // the citizenship threshold is 0.25% of the supply = 2 500 000 coins
const CITIZEN_MIN_COINS = 2_600_000n;
const OWNER_KEEP_COINS = 10_000_000n;  // the owner keeps enough coins to create proposals and to outvote the citizen
const MIN_OWNER_SOL = 100_000_000n;    // 0.1 SOL
const MIN_TREASURY = 20_000_000n;      // 0.02 SOL

type Actor = { name: string; pk: PublicKey; provider: anchor.AnchorProvider; program: any };
type Ctx = { conn: Connection; owner: Actor; fin: Actor; cul: Actor; citizen?: Actor; pres?: Actor };

const big = (x: any): bigint => BigInt(x.toString());
const bn = (x: bigint | number): anchor.BN => new anchor.BN(x.toString());
const sol = (l: bigint): string => (Number(l) / 1e9).toFixed(6) + " SOL";
const msk = (ts: number): string => new Date(ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function actorFrom(name: string): Actor | undefined {
  const f = walletFile(name);
  if (!fs.existsSync(f)) return undefined;
  const provider = getProvider(f);
  return { name, pk: provider.wallet.publicKey, provider, program: loadProgram(provider) };
}
async function makeCtx(): Promise<Ctx> {
  const provider = getProvider(); // the owner: ANCHOR_WALLET
  const owner: Actor = { name: "owner", pk: provider.wallet.publicKey, provider, program: loadProgram(provider) };
  const cfg: any = await owner.program.account.config.fetch(configPda());
  if (!cfg.ownersAuthority.equals(owner.pk)) throw new Error("this wallet is not the owner of the state - wrong ANCHOR_WALLET?");
  const fin = actorFrom("finance-minister"), cul = actorFrom("culture-minister");
  if (!fin || !cul) throw new Error(`no minister wallets in ${walletFile("finance-minister")} / culture-minister (wave 1 helpers)`);
  if (!cfg.financeMinister.equals(fin.pk) || !cfg.cultureMinister.equals(cul.pk)) throw new Error("the helper wallets are not the appointed ministers of this state");
  return { conn: provider.connection, owner, fin, cul, citizen: actorFrom("citizen"), pres: actorFrom("president-test") };
}
const fetchCfg = (c: Ctx): Promise<any> => c.owner.program.account.config.fetch(configPda());

async function tokenAmount(conn: Connection, addr: PublicKey, programId: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(addr, "confirmed");
  return info ? unpackAccount(addr, info, programId).amount : 0n;
}
const wsol = (c: Ctx, who: PublicKey) => tokenAmount(c.conn, treasuryAtaOf(who), TREASURY_PROGRAM);
const treasuryNow = (c: Ctx) => tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM);
const createAta = (payer: PublicKey, wallet: PublicKey) => createAssociatedTokenAccountIdempotentInstruction(payer, treasuryAtaOf(wallet), wallet, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM);

// =====================================================================================================================
// prep
// =====================================================================================================================
async function stepPrep() {
  log("--- prep: helper wallets, SOL for their fees, coins for the citizen");
  for (const name of ["citizen", "president-test"]) {
    if (fs.existsSync(walletFile(name))) continue;
    if (CONFIRM) log(`created wallet ${name}: ${createWalletFile(name).publicKey.toBase58()}  (file ${walletFile(name)})`);
    else note(`would create the wallet ${name} (${walletFile(name)})`);
  }
  const c = await makeCtx();
  const { conn, owner } = c;
  const ownerSol = BigInt(await conn.getBalance(owner.pk, "confirmed"));
  if (ownerSol < MIN_OWNER_SOL) throw new Error(`the owner wallet has only ${sol(ownerSol)} - need at least ${sol(MIN_OWNER_SOL)}`);
  note(`owner ${owner.pk.toBase58()}: ${sol(ownerSol)}`);

  // SOL for fees (and for the account rent of the ministers)
  for (const [name, target] of Object.entries(TOPUP)) {
    const a = actorFrom(name);
    if (!a) { note(`${name}: (wallet will be created with CONFIRM=yes)`); continue; }
    const bal = BigInt(await conn.getBalance(a.pk, "confirmed"));
    if (bal * 10n >= target * 6n) { note(`${name} ${a.pk.toBase58()}: ${sol(bal)} - enough`); continue; }
    const need = target - bal;
    if (!CONFIRM) { note(`would send ${sol(need)} to ${name} (${a.pk.toBase58()})`); continue; }
    const sig = await owner.provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({ fromPubkey: owner.pk, toPubkey: a.pk, lamports: Number(need) })));
    tx(`fund ${name} ${sol(need)}`, sig);
  }

  // the owner's account for the treasury asset (wSOL): the spends and the salary arrive there
  if (!(await conn.getAccountInfo(treasuryAtaOf(owner.pk), "confirmed"))) {
    if (!CONFIRM) note("would create the owner's wSOL account");
    else tx("create the owner's wSOL account", await owner.provider.sendAndConfirm(new Transaction().add(createAta(owner.pk, owner.pk))));
  }

  // coins for the citizen
  const citizen = actorFrom("citizen");
  if (citizen) {
    const mint = await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
    const unit = 10n ** BigInt(mint.decimals);
    const have = await tokenAmount(conn, ata(citizen.pk), TOKEN_PROGRAM);
    if (have >= CITIZEN_MIN_COINS * unit) note(`citizen ${citizen.pk.toBase58()}: ${have / unit} coins - enough`);
    else {
      const amount = CITIZEN_COINS * unit;
      const ownerCoins = await tokenAmount(conn, ata(owner.pk), TOKEN_PROGRAM);
      if (ownerCoins - amount < OWNER_KEEP_COINS * unit) throw new Error(`the owner holds ${ownerCoins / unit} coins; sending ${CITIZEN_COINS} would leave too few`);
      if (!CONFIRM) note(`would send ${CITIZEN_COINS} coins to the citizen (the owner keeps ${(ownerCoins - amount) / unit})`);
      else {
        const t = new Transaction().add(
          createAssociatedTokenAccountIdempotentInstruction(owner.pk, ata(citizen.pk), citizen.pk, GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM),
          createTransferCheckedInstruction(ata(owner.pk), GOVERNANCE_MINT, ata(citizen.pk), owner.pk, amount, mint.decimals, [], TOKEN_PROGRAM)
        );
        tx(`send ${CITIZEN_COINS} coins to the citizen`, await owner.provider.sendAndConfirm(t));
      }
    }
  }
  if (!CONFIRM) log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front.");
}

// =====================================================================================================================
// money: salaries, minister limits, pause, milestone
// =====================================================================================================================
function claimSalaryTx(a: Actor, role: number) {
  return a.program.methods.claimSalary(role)
    .accounts({ claimant: a.pk, config: configPda(), treasuryMint: TREASURY_MINT, payrollClaim: payrollPda(role), treasury: treasuryAta(), claimantTokenAccount: treasuryAtaOf(a.pk), tokenProgram: TREASURY_PROGRAM, systemProgram: SystemProgram.programId })
    .preInstructions([createAta(a.pk, a.pk)]).rpc();
}
function ministerSpendTx(a: Actor, role: number, amount: bigint) {
  return a.program.methods.ministerSpend(role, bn(amount), "wave 2 check")
    .accounts({ minister: a.pk, config: configPda(), treasuryMint: TREASURY_MINT, spendTracker: spendTrackerPda(role), treasury: treasuryAta(), recipientTokenAccount: treasuryAtaOf(a.pk), tokenProgram: TREASURY_PROGRAM, systemProgram: SystemProgram.programId })
    .preInstructions([createAta(a.pk, a.pk)]).rpc();
}

async function salary(c: Ctx, a: Actor, role: number, title: string) {
  const claim = await a.program.account.payrollClaim.fetchNullable(payrollPda(role));
  const now = await chainNow(c.conn);
  if (claim && now - Number(claim.lastClaimTs.toString()) < 86400) { note(`salary ${title}: already paid within the last 24 h (${msk(Number(claim.lastClaimTs.toString()))}) - skipped`); return; }
  const before = await wsol(c, a.pk);
  const sig = await claimSalaryTx(a, role);
  tx(`salary ${title}`, sig);
  const cfg = await fetchCfg(c);
  const bps = big([cfg.payrollPresidentBps, cfg.payrollFinanceBps, cfg.payrollCultureBps][role]);
  const expected = (big(cfg.treasurySnapshotAmount) * bps) / 10_000n;
  const got = (await wsol(c, a.pk)) - before;
  if (got === expected && expected > 0n) pass(`salary ${title}: ${got} lamports = ${bps} bps of the morning snapshot ${big(cfg.treasurySnapshotAmount)}`);
  else fail(`salary ${title}: received ${got}, expected ${expected}`);
}

async function ministerLimits(c: Ctx, a: Actor, role: number, title: string) {
  const cfg = await fetchCfg(c);
  const now = await chainNow(c.conn);
  const today = Math.floor(now / 86400);
  const base = Number(cfg.treasurySnapshotDay.toString()) === today ? big(cfg.treasurySnapshotAmount) : await treasuryNow(c);
  const dailyBps = big(role === 1 ? cfg.financeDailyBps : cfg.cultureDailyBps);
  const cap = (base * dailyBps) / 10_000n;
  const tracker = await a.program.account.spendTracker.fetchNullable(spendTrackerPda(role));
  let spent = tracker && now - Number(tracker.dailyWindowStart.toString()) < 86400 ? big(tracker.dailySpent) : 0n;
  note(`${title}: daily limit ${cap} lamports (${dailyBps} bps of ${base}), already spent in this window: ${spent}`);
  if (cap < 10n) { fail(`${title}: the limit is too small to test`); return; }
  const s1 = (cap * 8n) / 10n, s2 = (cap * 4n) / 10n;
  const spend = async (amount: bigint, label: string) => {
    const before = await wsol(c, a.pk);
    tx(`${title}: ${label} ${amount}`, await ministerSpendTx(a, role, amount));
    const got = (await wsol(c, a.pk)) - before;
    if (got === amount) pass(`${title}: ${label} ${amount} lamports arrived`); else fail(`${title}: ${label}: arrived ${got}, expected ${amount}`);
    spent += amount;
  };
  if (spent === 0n) await spend(s1, "spend inside the limit (80%)");
  if (spent + s2 > cap) await expectRefused(`${title}: ${s2} more on top of ${spent} (limit ${cap})`, "ExceedsDailyLimit", () => ministerSpendTx(a, role, s2));
  if (spent < cap) await spend(cap - spent, "spend the rest of the limit exactly");
  await expectRefused(`${title}: one lamport above the limit`, "ExceedsDailyLimit", () => ministerSpendTx(a, role, 1n));
}

async function pauseCheck(c: Ctx) {
  const { owner, fin } = c;
  let cfg = await fetchCfg(c);
  if (cfg.paused) { fail("the state is already paused - run set_pause.ts PAUSED=false first"); return; }
  const setPause = (p: boolean) => owner.program.methods.setPause(p).accounts({ admin: owner.pk, config: configPda() }).rpc();
  try {
    tx("pause ON", await setPause(true));
    cfg = await fetchCfg(c);
    cfg.paused ? pass("pause is ON on the chain") : fail("set_pause(true) did not take effect");
    await expectRefused("finance minister spend while paused", "Paused", () => ministerSpendTx(fin, 1, 1n));
    await expectRefused("finance minister salary claim while paused", "Paused", () => claimSalaryTx(fin, 1));
    // the fee collection is an inflow: the pause must not block it
    const r = spawnSync("npx", ["ts-node", "scripts/claim_pool_fees.ts"], { env: process.env, encoding: "utf8", cwd: __dirname + "/.." });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const m = out.match(/claim_pool_fees tx: (\S+)/);
    if (m) { tx("claim_pool_fees while paused", m[1]); pass("fee collection works while paused: " + (out.match(/treasury \+ (\d+)/)?.[0] ?? "")); }
    else if (/NothingToClaim|Nothing to claim/i.test(out)) note("fee collection while paused: nothing to collect right now (no new trades) - skipped");
    else fail("fee collection while paused: " + out.replace(/\s+/g, " ").slice(-200));
  } finally {
    for (let i = 0; i < 4; i++) {
      try { cfg = await fetchCfg(c); if (!cfg.paused) break; tx("pause OFF", await setPause(false)); cfg = await fetchCfg(c); if (!cfg.paused) break; } catch (e: any) { await sleep(2000); }
    }
    cfg = await fetchCfg(c);
    cfg.paused ? fail("!!! THE STATE IS STILL PAUSED - run: set_pause.ts with PAUSED=false") : pass("pause is OFF again");
  }
}

async function milestoneCycle(c: Ctx) {
  const { conn, owner, citizen } = c;
  const program = owner.program;
  const holders = [owner, citizen!];
  let st = loadState();
  let cfg = await fetchCfg(c);
  let n: number;
  if (st.milestone !== undefined) n = st.milestone;
  else {
    const next = Number(cfg.nextMilestoneNumber.toString());
    if (st.pendingMilestone !== undefined && next > st.pendingMilestone) { n = st.pendingMilestone; st.milestone = n; saveState(st); note(`milestone #${n} was created earlier (the answer was lost) - continuing`); }
    else {
      st.pendingMilestone = next; saveState(st);
      tx(`create_milestone #${next}`, await program.methods.createMilestone().accounts({ owner: owner.pk, config: configPda(), milestoneRecord: milestonePda(next), systemProgram: SystemProgram.programId }).rpc());
      n = next; st.milestone = n; saveState(st);
    }
  }
  const mPda = milestonePda(n);
  let rec = await program.account.milestoneRecord.fetch(mPda);
  const weights: Record<string, bigint> = {};
  if (!rec.finalized) {
    const infos = await conn.getMultipleAccountsInfo(holders.map((h) => ata(h.pk)), "confirmed"); // ONE consistent read of both balances
    for (let i = 0; i < holders.length; i++) {
      const h = holders[i];
      if (await program.account.milestoneSnapshot.fetchNullable(milestoneSnapPda(mPda, h.pk))) continue;
      const w = unpackAccount(ata(h.pk), infos[i]!, TOKEN_PROGRAM).amount;
      tx(`milestone #${n} snapshot ${h.name} (${w} raw coins)`, await program.methods.postMilestoneSnapshot(bn(n), h.pk, bn(w))
        .accounts({ owner: owner.pk, config: configPda(), governanceMint: GOVERNANCE_MINT, milestoneRecord: mPda, holderTokenAccount: ata(h.pk), milestoneSnapshot: milestoneSnapPda(mPda, h.pk), systemProgram: SystemProgram.programId }).rpc());
    }
    tx(`finalize_milestone #${n}`, await program.methods.finalizeMilestone(bn(n))
      .accounts({ owner: owner.pk, config: configPda(), milestoneRecord: mPda, previousMilestone: n > 1 ? milestonePda(n - 1) : null, milestoneFund: milestoneFundPda(), governanceMint: GOVERNANCE_MINT }).rpc());
    rec = await program.account.milestoneRecord.fetch(mPda);
  }
  const pool = (big(rec.fundSnapshotAmount) * big(rec.payoutBps)) / 10_000n;
  note(`milestone #${n}: payout ${rec.payoutBps} bps of the fund snapshot ${big(rec.fundSnapshotAmount)} = pool ${pool} lamports, total weight ${big(rec.totalEligibleWeight)}`);
  for (const h of holders) {
    const snap: any = await program.account.milestoneSnapshot.fetchNullable(milestoneSnapPda(mPda, h.pk));
    if (!snap) { fail(`milestone #${n}: no snapshot for ${h.name}`); continue; }
    if (snap.claimed) { note(`milestone #${n}: ${h.name} was already paid`); continue; }
    const expected = (pool * big(snap.weight)) / big(rec.totalEligibleWeight);
    const before = await wsol(c, h.pk);
    tx(`milestone #${n} payout to ${h.name}`, await program.methods.claimMilestone(bn(n), h.pk)
      .accounts({ payer: owner.pk, config: configPda(), treasuryMint: TREASURY_MINT, milestoneRecord: mPda, milestoneSnapshot: milestoneSnapPda(mPda, h.pk), milestoneFund: milestoneFundPda(), claimantTokenAccount: treasuryAtaOf(h.pk), tokenProgram: TREASURY_PROGRAM })
      .preInstructions([createAta(owner.pk, h.pk)]).rpc());
    const got = (await wsol(c, h.pk)) - before;
    got === expected ? pass(`milestone payout ${h.name}: ${got} lamports = pool x weight share`) : fail(`milestone payout ${h.name}: received ${got}, expected ${expected}`);
  }
  await expectRefused(`milestone #${n}: a second payout to the owner`, "AlreadyClaimedMilestone", () => program.methods.claimMilestone(bn(n), owner.pk)
    .accounts({ payer: owner.pk, config: configPda(), treasuryMint: TREASURY_MINT, milestoneRecord: mPda, milestoneSnapshot: milestoneSnapPda(mPda, owner.pk), milestoneFund: milestoneFundPda(), claimantTokenAccount: treasuryAtaOf(owner.pk), tokenProgram: TREASURY_PROGRAM }).rpc());
  await expectRefused(`milestone #${n}: return the unpaid part before the grace period is over`, "MilestoneGraceNotElapsed", () => program.methods.releaseMilestoneReserve(bn(n))
    .accounts({ owner: owner.pk, config: configPda(), milestoneRecord: mPda }).rpc());
}

async function stepMoney() {
  const c = await makeCtx();
  if (!c.citizen) throw new Error("run the prep step first");
  const cfg = await fetchCfg(c);
  if (cfg.paused) throw new Error("the state is paused - unpause first");
  const tre = await treasuryNow(c);
  if (tre < MIN_TREASURY) throw new Error(`the treasury holds only ${sol(tre)}`);
  log(`--- money: treasury ${sol(tre)}; salaries, minister limits, pause, milestone cycle`);
  if (!CONFIRM) {
    note("plan: president / finance / culture salaries (+ a refusal of a second claim); finance and culture minister: spend 80% of the daily limit, refusal of 40% more, spend the rest, refusal of 1 more lamport;");
    note("      pause ON -> a minister spend and a salary are refused, the fee collection still works -> pause OFF; milestone: create, 2 snapshots (owner, citizen), finalize, 2 payouts, refusals of a second payout and of an early release");
    log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front.");
    return;
  }
  await salary(c, c.owner, 0, "president (the owner)");
  await salary(c, c.fin, 1, "finance minister");
  await salary(c, c.cul, 2, "culture minister");
  await expectRefused("finance minister claims the salary a second time", "PayrollTooSoon", () => claimSalaryTx(c.fin, 1));
  await ministerLimits(c, c.fin, 1, "finance minister");
  await ministerLimits(c, c.cul, 2, "culture minister");
  await pauseCheck(c);
  await milestoneCycle(c);
}

// =====================================================================================================================
// votes
// =====================================================================================================================
type Spec = { label: string; type: number; target: PublicKey; amount: number; reason: string; enroll: Actor[]; votes: Array<[Actor, boolean]> };

function buildSpecs(c: Ctx): Spec[] {
  const { owner, citizen, pres } = c;
  if (!citizen || !pres) throw new Error("run the prep step first");
  return [
    // the president's fallback test starts first: its clock is the long one (voting + fallback)
    { label: "FALLBACK", type: 0, target: owner.pk, amount: 300_000, reason: "wave 2: spend that the TEST PRESIDENT executes after the fallback time", enroll: [owner], votes: [[owner, true]] },
    { label: "PRES", type: 1, target: pres.pk, amount: 0, reason: "wave 2: president -> test wallet", enroll: [owner, citizen], votes: [[owner, true], [citizen, true]] },
    { label: "SPEND2", type: 0, target: owner.pk, amount: 500_000, reason: "wave 2: spend, two voters (owner for, citizen against)", enroll: [owner, citizen], votes: [[owner, true], [citizen, false]] },
    { label: "REJECT", type: 0, target: owner.pk, amount: 400_000, reason: "wave 2: must be REJECTED (owner against, citizen for)", enroll: [owner, citizen], votes: [[owner, false], [citizen, true]] },
    { label: "QUORUM", type: 0, target: owner.pk, amount: 300_000, reason: "wave 2: nobody votes - no quorum", enroll: [owner], votes: [] },
    { label: "RESTORE", type: 1, target: owner.pk, amount: 0, reason: "wave 2: president back to the owner", enroll: [owner], votes: [[owner, true]] },
  ];
}

async function ensureProposal(c: Ctx, spec: Spec): Promise<number> {
  const { owner, conn } = c;
  const program = owner.program;
  let st = loadState();
  let id = st.ids[spec.label];
  const matches = async (pid: number) => {
    const p: any = await program.account.proposal.fetchNullable(proposalPda(pid));
    return !!p && p.creator.equals(owner.pk) && Number(p.proposalType) === spec.type && p.target.equals(spec.target) && big(p.amount) === BigInt(spec.amount);
  };
  if (id === undefined) {
    const cfg = await fetchCfg(c);
    const count = Number(cfg.proposalCount.toString());
    const pend = st.pending[spec.label];
    if (pend !== undefined && count > pend) {
      if (!(await matches(pend))) throw new Error(`${spec.label}: proposal #${pend} exists but is not the one this wave created - look at it before going on`);
      id = pend; note(`${spec.label}: #${id} was created earlier (the answer was lost) - continuing`);
    } else {
      st.pending[spec.label] = count; saveState(st);
      const sig = await program.methods.createProposal(spec.type, spec.target, bn(spec.amount), 0, spec.reason)
        .accounts({ creator: owner.pk, config: configPda(), governanceMint: GOVERNANCE_MINT, creatorTokenAccount: ata(owner.pk), treasury: treasuryAta(), quorumExcluded: excludedAccountOf(cfg), proposal: proposalPda(count), systemProgram: SystemProgram.programId }).rpc();
      tx(`create_proposal ${spec.label} (#${count})`, sig);
      id = count;
    }
    st = loadState(); st.ids[spec.label] = id; delete st.pending[spec.label]; saveState(st);
  }
  const pda = proposalPda(id);
  let p: any = await program.account.proposal.fetch(pda);
  if (!p.votingOpen) {
    const infos = await conn.getMultipleAccountsInfo(spec.enroll.map((a) => ata(a.pk)), "confirmed"); // ONE consistent read of the balances
    for (let i = 0; i < spec.enroll.length; i++) {
      const a = spec.enroll[i];
      if (await program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, a.pk))) continue;
      const w = unpackAccount(ata(a.pk), infos[i]!, TOKEN_PROGRAM).amount;
      tx(`snapshot ${spec.label} (#${id}) ${a.name} (${w} raw coins)`, await program.methods.postVoterSnapshot(bn(id), a.pk, bn(w))
        .accounts({ owner: owner.pk, config: configPda(), proposal: pda, voterTokenAccount: ata(a.pk), voterSnapshot: voterSnapshotPda(pda, a.pk), systemProgram: SystemProgram.programId }).rpc());
    }
    const cfg = await fetchCfg(c);
    tx(`open_voting ${spec.label} (#${id})`, await program.methods.openVoting(bn(id))
      .accounts({ owner: owner.pk, config: configPda(), governanceMint: GOVERNANCE_MINT, proposal: pda, quorumExcluded: excludedAccountOf(cfg) }).rpc());
    p = await program.account.proposal.fetch(pda);
  }
  for (const [a, support] of spec.votes) {
    const snap: any = await a.program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, a.pk));
    if (!snap) throw new Error(`${spec.label}: ${a.name} has no snapshot`);
    if (snap.consumed) continue;
    tx(`vote ${support ? "FOR    " : "AGAINST"} ${spec.label} (#${id}) by ${a.name}`, await a.program.methods.vote(bn(id), support)
      .accounts({ voter: a.pk, config: configPda(), proposal: pda, voterSnapshot: voterSnapshotPda(pda, a.pk) }).rpc());
  }
  return id;
}

function executeTx(a: Actor, id: number, recipientOwner?: PublicKey) {
  return a.program.methods.executeProposal(bn(id))
    .accounts({ executor: a.pk, config: configPda(), treasuryMint: TREASURY_MINT, proposal: proposalPda(id), treasury: treasuryAta(), recipientTokenAccount: recipientOwner ? treasuryAtaOf(recipientOwner) : null, milestoneFund: null, tokenProgram: TREASURY_PROGRAM })
    .preInstructions(recipientOwner ? [createAta(a.pk, recipientOwner)] : []).rpc();
}

async function stepVotes() {
  const c = await makeCtx();
  const specs = buildSpecs(c);
  const cfg = await fetchCfg(c);
  if (cfg.paused) throw new Error("the state is paused - unpause first");
  log(`--- votes: ${specs.length} proposals (voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s, fallback ${cfg.execFallbackSecs} s)`);
  if (!CONFIRM) {
    for (const s of specs) note(`${s.label}: type ${s.type}, ${s.amount ? s.amount + " lamports, " : ""}target ${s.target.toBase58().slice(0, 8)}…, voters ${s.enroll.map((a) => a.name).join("+")}, votes: ${s.votes.map(([a, v]) => a.name + (v ? " for" : " against")).join(", ") || "none"}`);
    log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front.");
    return;
  }
  const ids: Record<string, number> = {};
  for (const s of specs) ids[s.label] = await ensureProposal(c, s);

  // refusals while the votes are open (done once)
  let st = loadState();
  if (!st.done.negVotes) {
    const { owner, fin, citizen } = c;
    const pda = proposalPda(ids.SPEND2);
    await expectRefused("execute BEFORE the voting has ended", "ProposalStillActive", () => executeTx(owner, ids.SPEND2, owner.pk));
    await expectRefused("the owner votes a second time", "AlreadyVoted", () => owner.program.methods.vote(bn(ids.SPEND2), true).accounts({ voter: owner.pk, config: configPda(), proposal: pda, voterSnapshot: voterSnapshotPda(pda, owner.pk) }).rpc());
    await expectRefused("a wallet without a snapshot votes", ["AccountNotInitialized", "NotYourSnapshot"], () => fin.program.methods.vote(bn(ids.SPEND2), true).accounts({ voter: fin.pk, config: configPda(), proposal: pda, voterSnapshot: voterSnapshotPda(pda, fin.pk) }).rpc());
    const qpda = proposalPda(ids.QUORUM);
    await expectRefused("a voter is added after the voting has opened", "VotingAlreadyOpen", () => owner.program.methods.postVoterSnapshot(bn(ids.QUORUM), citizen!.pk, bn(1_000_000_000n))
      .accounts({ owner: owner.pk, config: configPda(), proposal: qpda, voterTokenAccount: ata(citizen!.pk), voterSnapshot: voterSnapshotPda(qpda, citizen!.pk), systemProgram: SystemProgram.programId }).rpc());
    st = loadState(); st.done.negVotes = new Date().toISOString(); saveState(st);
  }
  const now = await chainNow(c.conn);
  log("\nproposals:");
  for (const s of specs) {
    const p: any = await c.owner.program.account.proposal.fetch(proposalPda(ids[s.label]));
    const deadline = Number(p.deadline.toString());
    note(`#${ids[s.label]} ${s.label.padEnd(8)} votes for ${big(p.votesFor)} / against ${big(p.votesAgainst)} | voting ends ${msk(deadline)} (in ${Math.max(0, deadline - now)} s)`);
  }
  log("\nNext: in ~6 minutes the step 'execute' (the president's fallback comes later - the step prints when).");
}

// =====================================================================================================================
// execute
// =====================================================================================================================
async function stepExecute() {
  const c = await makeCtx();
  const { conn, owner, fin, citizen, pres } = c;
  if (!citizen || !pres) throw new Error("run the prep step first");
  let st = loadState();
  const L = st.ids;
  for (const k of ["PRES", "SPEND2", "REJECT", "QUORUM", "FALLBACK", "RESTORE"]) if (L[k] === undefined) throw new Error(`the proposal ${k} has not been created: run the step 'votes' first`);
  let cfg = await fetchCfg(c);
  if (cfg.paused) throw new Error("the state is paused - unpause first");
  const now = await chainNow(conn);
  const get = async (label: string) => ({ id: L[label], p: (await owner.program.account.proposal.fetch(proposalPda(L[label]))) as any });
  const markDone = (key: string) => { const s = loadState(); s.done[key] = new Date().toISOString(); saveState(s); st = s; };
  const ended = (p: any) => p.votingOpen && now > Number(p.deadline.toString());
  const left = (p: any) => Number(p.deadline.toString()) - now;
  log(`--- execute (chain time ${msk(now)}; voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s, fallback ${cfg.execFallbackSecs} s)`);
  if (!CONFIRM) { log("DRY RUN (plan only; refusal checks are simulations and cost nothing, real executions need CONFIRM=yes)"); }

  // ---- PRES: the owner executes -> the test wallet becomes the president
  { const { id, p } = await get("PRES");
    if (p.executed) note(`PRES #${id}: already executed`);
    else if (!ended(p)) note(`PRES #${id}: the voting is still running (${left(p)} s)`);
    else if (CONFIRM) {
      tx(`execute PRES #${id} (owner)`, await executeTx(owner, id));
      cfg = await fetchCfg(c);
      cfg.president.equals(pres.pk) ? pass("president is now the test wallet " + pres.pk.toBase58()) : fail("president did not change");
    } else note(`PRES #${id}: would be executed by the owner`);
  }
  // ---- SPEND2: refusals, then the owner executes
  { const { id, p } = await get("SPEND2");
    if (p.executed) note(`SPEND2 #${id}: already executed`);
    else if (!ended(p)) note(`SPEND2 #${id}: the voting is still running (${left(p)} s)`);
    else {
      if (!st.done.negExec) {
        await expectRefused("a minister (not the owner) tries to execute a passed proposal", "NotOwner", () => executeTx(fin, id, owner.pk));
        await expectRefused("execute with a recipient that is not the approved one", "WrongRecipient", () => executeTx(owner, id, citizen.pk));
        if (CONFIRM) markDone("negExec");
      }
      if (CONFIRM) {
        const before = await wsol(c, owner.pk);
        tx(`execute SPEND2 #${id} (owner)`, await executeTx(owner, id, owner.pk));
        const got = (await wsol(c, owner.pk)) - before;
        got === big(p.amount) ? pass(`SPEND2: ${got} lamports arrived at the owner`) : fail(`SPEND2: arrived ${got}, expected ${big(p.amount)}`);
      } else note(`SPEND2 #${id}: would be executed by the owner`);
    }
  }
  // ---- REJECT and QUORUM: the contract must refuse
  for (const [label, code] of [["REJECT", "ProposalRejected"], ["QUORUM", "QuorumNotReached"]] as const) {
    const { id, p } = await get(label);
    if (st.done["refused" + label]) { note(`${label} #${id}: refusal already checked`); continue; }
    if (!ended(p)) { note(`${label} #${id}: the voting is still running (${left(p)} s)`); continue; }
    const ok = await expectRefused(`${label} #${id}: execution of a proposal that ${label === "REJECT" ? "lost the vote" : "had no quorum"}`, code, () => executeTx(owner, id, owner.pk));
    if (ok) markDone("refused" + label);
  }
  // ---- FALLBACK: the test president executes after the fallback time
  { const { id, p } = await get("FALLBACK");
    cfg = await fetchCfg(c);
    if (p.executed) note(`FALLBACK #${id}: already executed`);
    else if (!ended(p)) note(`FALLBACK #${id}: the voting is still running (${left(p)} s)`);
    else if (!cfg.president.equals(pres.pk)) note(`FALLBACK #${id}: waiting - the test wallet is not the president yet (PRES must be executed first)`);
    else {
      const ready = Number(p.deadline.toString()) + Number(cfg.timelockSecs.toString()) + Number(cfg.execFallbackSecs.toString());
      if (now < ready) {
        if (!st.done.negPresEarly) { const ok = await expectRefused("the president tries to execute BEFORE the fallback time", "NotOwner", () => executeTx(pres, id, owner.pk)); if (ok && CONFIRM) markDone("negPresEarly"); }
        log(`      FALLBACK #${id}: the president may execute from ${msk(ready)} (in ${ready - now} s) - run this step again then`);
      } else if (CONFIRM) {
        const before = await wsol(c, owner.pk);
        tx(`execute FALLBACK #${id} (TEST PRESIDENT, owner silent)`, await executeTx(pres, id, owner.pk));
        const got = (await wsol(c, owner.pk)) - before;
        got === big(p.amount) ? pass(`FALLBACK: the president executed it, ${got} lamports arrived at the owner`) : fail(`FALLBACK: arrived ${got}, expected ${big(p.amount)}`);
      } else note(`FALLBACK #${id}: the test president would execute it now`);
    }
  }
  // ---- RESTORE: after the fallback check the president goes back to the owner
  { const { id, p } = await get("RESTORE");
    const fb = (await get("FALLBACK")).p;
    cfg = await fetchCfg(c);
    if (p.executed) note(`RESTORE #${id}: already executed`);
    else if (!ended(p)) note(`RESTORE #${id}: the voting is still running (${left(p)} s)`);
    else if (!fb.executed) note(`RESTORE #${id}: waiting until the fallback check is done (the president must stay the test wallet until then)`);
    else if (CONFIRM) {
      tx(`execute RESTORE #${id} (owner)`, await executeTx(owner, id));
      cfg = await fetchCfg(c);
      cfg.president.equals(owner.pk) ? pass("president is the owner again") : fail("president did not return");
    } else note(`RESTORE #${id}: would be executed by the owner`);
  }
  const fresh = await Promise.all(["PRES", "SPEND2", "FALLBACK", "RESTORE"].map(async (k) => (await get(k)).p.executed));
  if (fresh.every(Boolean) && st.done.refusedREJECT && st.done.refusedQUORUM) log("\nALL WAVE 2 PROPOSALS ARE DONE. Next: the report of transactions, then (optionally) the cleanup.");
}

// =====================================================================================================================
// cleanup + status
// =====================================================================================================================
async function stepCleanup() {
  const c = await makeCtx();
  const { conn, owner, citizen } = c;
  const program = owner.program;
  const cfg = await fetchCfg(c);
  const count = Number(cfg.proposalCount.toString());
  const now = await chainNow(conn);
  const voters = [owner, ...(citizen ? [citizen] : [])];
  log(`--- cleanup: ${count} proposals (a proposal can be closed when it is executed or expired; its voter snapshots when the voting has ended)`);
  const before = BigInt(await conn.getBalance(owner.pk, "confirmed"));
  let snaps = 0, props = 0;
  for (let id = 0; id < count; id++) {
    const pda = proposalPda(id);
    const p: any = await program.account.proposal.fetchNullable(pda);
    if (!p) continue;
    const votingEnded = p.votingOpen && now > Number(p.deadline.toString());
    for (const v of voters) {
      const sPda = voterSnapshotPda(pda, v.pk);
      if (!votingEnded || !(await program.account.voterSnapshot.fetchNullable(sPda))) continue;
      if (!CONFIRM) { note(`would close the snapshot of ${v.name} on #${id}`); snaps++; continue; }
      tx(`close snapshot #${id} ${v.name}`, await program.methods.closeVoterSnapshot(bn(id), v.pk)
        .accounts({ caller: owner.pk, config: configPda(), proposal: pda, voterSnapshot: sPda, ownerRefund: cfg.ownersAuthority }).rpc());
      snaps++;
    }
    if (p.executed) {
      if (!CONFIRM) { note(`would close the executed proposal #${id}`); props++; continue; }
      tx(`close proposal #${id}`, await program.methods.closeProposal(bn(id)).accounts({ caller: owner.pk, config: configPda(), proposal: pda, creator: p.creator }).rpc());
      props++;
    } else note(`#${id}: not executed - it stays until it expires (${msk(Number(p.deadline.toString()) + Number(cfg.timelockSecs.toString()) + Number(cfg.execFallbackSecs.toString()) + 30 * 86400)})`);
  }
  const after = BigInt(await conn.getBalance(owner.pk, "confirmed"));
  log(CONFIRM ? `closed ${snaps} snapshots and ${props} proposals; the owner wallet ${sol(before)} -> ${sol(after)} (${after >= before ? "+" : ""}${sol(after - before)} incl. fees)` : `\nDRY RUN: ${snaps} snapshots and ${props} proposals could be closed now. Run with CONFIRM=yes to do it.`);
}

async function stepStatus() {
  const c = await makeCtx();
  const st = loadState();
  const cfg = await fetchCfg(c);
  const now = await chainNow(c.conn);
  log(`--- status (chain time ${msk(now)}) | state file ${STATE_FILE} | journal ${LOG_FILE}`);
  log(`windows: voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s, spend pause ${cfg.spendCooldownSecs} s, fallback ${cfg.execFallbackSecs} s | paused: ${cfg.paused} | president ${cfg.president.toBase58().slice(0, 8)}…`);
  log(`treasury ${sol(await treasuryNow(c))} | milestone fund ${sol(await tokenAmount(c.conn, milestoneFundPda(), TREASURY_PROGRAM))} | owner ${sol(BigInt(await c.conn.getBalance(c.owner.pk, "confirmed")))}`);
  for (const [label, id] of Object.entries(st.ids)) {
    const p: any = await c.owner.program.account.proposal.fetchNullable(proposalPda(id));
    if (!p) { note(`${label} #${id}: closed`); continue; }
    const dl = Number(p.deadline.toString());
    note(`${label.padEnd(8)} #${id}: ${p.executed ? "EXECUTED" : p.votingOpen ? (now <= dl ? `voting, ${dl - now} s left` : "voting ended, not executed") : "voting not opened"} | for ${big(p.votesFor)} against ${big(p.votesAgainst)}`);
  }
  if (st.milestone !== undefined) note(`milestone #${st.milestone}`);
  note("checks already done: " + (Object.keys(st.done).join(", ") || "none"));
}

async function main() {
  const step = process.argv[2] ?? "status";
  const steps: Record<string, () => Promise<void>> = { prep: stepPrep, money: stepMoney, votes: stepVotes, execute: stepExecute, cleanup: stepCleanup, status: stepStatus };
  if (!steps[step]) throw new Error(`unknown step "${step}" - one of: ${Object.keys(steps).join(", ")}`);
  await steps[step]();
  process.exit(summary(step));
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
