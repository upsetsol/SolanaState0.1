// WIND-DOWN of the state's treasury: pull the wSOL out of the treasury into the owner wallet BY GOVERNANCE, BEFORE the program is closed.
// After the program is closed the treasury (a PDA of that program) can never sign again and whatever is left in it is stuck for ever.
//
// One SPEND proposal may take at most 30 % of the treasury (MAX_SPEND_BPS in the contract, a re-check at execution time), so the treasury is
// emptied by a series of proposals, each worth 30 % of what the previous ones leave: 0.3*B, 0.3*0.7*B, 0.3*0.7^2*B, ... Every piece is a normal
// proposal (create, owner's voter record, open the voting, vote FOR); all the voting windows run side by side and the pieces are executed in
// order afterwards. The owner is the only voter (it holds the coins that count for the quorum). Steps (each is safe to run again: it looks at
// the chain first and does only what is missing; without CONFIRM=yes a step only prints its plan):
//   status   read-only: treasury, pending pool fee, the quorum check, the planned series, progress of every proposal
//   claim    move the trading fee waiting on the pool position into the treasury first (runs scripts/claim_pool_fees.ts; permissionless)
//   open     create every proposal of the series, enrol the owner, open the voting, vote FOR (resumable: never creates a duplicate)
//   finish   after the voting windows: execute the pieces in order, close the voter records and proposals (deposits come back),
//            then turn the wSOL on the owner wallet into SOL (closes the owner's wSOL account)
//   rent     close EVERY old proposal and voter record the contract allows (executed, or expired and not executed) and take the deposits back;
//            it looks at all accounts of the program, so it also cleans up what earlier tests left. Do it before the program is closed.
// Run through scripts/winddown_treasury.sh (it sets the network and the wallet). Journal: ~/winddown-treasury.log, progress: ~/winddown-treasury.state.json.

import { execFileSync } from "child_process";
import { PublicKey, SystemProgram, Transaction, Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, unpackAccount, getMint } from "@solana/spl-token";
import {
  anchor, getProvider, loadProgram, GOVERNANCE_MINT, TOKEN_PROGRAM, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM,
  configPda, treasuryAta, treasuryAtaOf, ata, proposalPda, voterSnapshotPda, excludedAccountOf, chainNow, readPendingPoolFee,
} from "./lib/env";
import { CONFIRM, STATE_FILE, LOG_FILE, loadState, saveState, log, tx, note, errCode, summary } from "./lib/gov2";

const MAX_SPEND_BPS = 3000n;                                                  // the contract's ceiling for ONE spend proposal: 30 % of the treasury
const MIN_PIECE = BigInt(process.env.MIN_PIECE ?? "100000");                  // lamports: a smaller piece costs more in fees (7 transactions) than it brings
const MAX_PROPOSALS = Number(process.env.MAX_PROPOSALS ?? "40");
const DEPOSIT_PER_PROPOSAL = 8_000_000n;                                      // lamports kept in reserve per proposal (rent of the proposal + voter record; comes back at close)
const SERIES_KEY = "series";                                                  // the planned pieces are stored in the state file so that a resume never re-plans

const big = (x: any): bigint => BigInt(x.toString());
const bn = (x: bigint | number): anchor.BN => new anchor.BN(x.toString());
const msk = (ts: number): string => new Date(ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК";
const sol = (l: bigint): string => (Number(l) / 1e9).toFixed(9) + " SOL";
const labelOf = (i: number): string => `WD${i}`;

type Ctx = { conn: Connection; provider: anchor.AnchorProvider; program: any; owner: PublicKey };
function makeCtx(): Ctx {
  const provider = getProvider();
  return { conn: provider.connection, provider, program: loadProgram(provider), owner: provider.wallet.publicKey };
}
const fetchCfg = (c: Ctx): Promise<any> => c.program.account.config.fetch(configPda());
async function tokenAmount(conn: Connection, addr: PublicKey, programId: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(addr, "confirmed");
  return info ? unpackAccount(addr, info, programId).amount : 0n;
}
async function guardOwner(c: Ctx) {
  const cfg = await fetchCfg(c);
  if (!cfg.ownersAuthority.equals(c.owner)) throw new Error("this wallet is not the owner of the state - wrong wallet file?");
  return cfg;
}

/** The pieces: each is exactly what the contract allows for one spend at that moment (30 % of what is left, rounded down like the contract does). */
function planSeries(balance: bigint): bigint[] {
  const out: bigint[] = [];
  let bal = balance;
  while (out.length < MAX_PROPOSALS) {
    const piece = (bal * MAX_SPEND_BPS) / 10_000n;
    if (piece < MIN_PIECE) break;
    out.push(piece);
    bal -= piece;
  }
  return out;
}
const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

/** Owner's weight against the quorum and the creation threshold, measured the way the contract measures them (base = supply minus the pool vault). */
async function quorumCheck(c: Ctx, cfg: any) {
  const mint = await getMint(c.conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  const exAcc = excludedAccountOf(cfg);
  const excluded = exAcc ? await tokenAmount(c.conn, exAcc, TOKEN_PROGRAM) : 0n;
  const base = mint.supply > excluded ? mint.supply - excluded : 0n;
  const mine = await tokenAmount(c.conn, ata(c.owner), TOKEN_PROGRAM);
  const qbps = big(cfg.quorumSpendBps), tbps = big(cfg.proposalThresholdBps);
  const pct = (x: bigint): string => (base === 0n ? "n/a" : (Number((x * 10_000n) / base) / 100).toFixed(2) + " %");
  return {
    base, mine, qbps, tbps, unit: 10n ** BigInt(mint.decimals),
    quorumOk: mine * 10_000n >= base * qbps, thresholdOk: mine * 10_000n >= base * tbps, share: pct(mine),
  };
}

// =====================================================================================================================
async function stepStatus() {
  const c = makeCtx();
  const cfg = await fetchCfg(c);
  const now = await chainNow(c.conn);
  log(`--- status (chain time ${msk(now)}) | state file ${STATE_FILE} | journal ${LOG_FILE}`);
  note(`this wallet ${c.owner.toBase58()} ${cfg.ownersAuthority.equals(c.owner) ? "IS the owner of the state" : "is NOT the owner (read-only view)"}`);
  const treasury = await tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM);
  note(`treasury ${treasuryAta().toBase58()}: ${sol(treasury)} (wSOL)`);
  if (cfg.feePool && !cfg.feePool.equals(PublicKey.default)) {
    const pend = await readPendingPoolFee(c.conn, cfg.feePool, cfg.feePosition);
    note(`trading fee waiting on the pool position: ${sol(pend.feeB)} (step 'claim' moves it into the treasury)`);
  }
  note(`owner wallet: ${sol(BigInt(await c.conn.getBalance(c.owner, "confirmed")))}`);
  const q = await quorumCheck(c, cfg);
  note(`voting base ${q.base} raw coins; the owner holds ${q.mine} (${q.share}); the quorum needs ${Number(q.qbps) / 100} % -> ${q.quorumOk ? "ENOUGH" : "NOT ENOUGH"}; creating a proposal needs ${Number(q.tbps) / 100} % -> ${q.thresholdOk ? "ok" : "NOT ok"}`);
  note(`windows: voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s, pause between spends ${cfg.spendCooldownSecs} s | paused: ${cfg.paused} | proposals so far: ${cfg.proposalCount}`);

  const st = loadState();
  const stored: bigint[] | null = st.done[SERIES_KEY] ? JSON.parse(st.done[SERIES_KEY]).map((x: string) => BigInt(x)) : null;
  const series = stored ?? planSeries(treasury);
  const left = (stored ? treasury : treasury) - sum(series);
  note(`${stored ? "FIXED" : "planned"} series: ${series.length} proposals, first ${sol(series[0] ?? 0n)}, last ${sol(series[series.length - 1] ?? 0n)}, together ${sol(sum(series))}`);
  note(`what would stay in the treasury afterwards: about ${sol(left > 0n ? left : 0n)}; deposits needed on the owner wallet meanwhile: about ${sol(DEPOSIT_PER_PROPOSAL * BigInt(series.length))} (they come back)`);
  for (let i = 0; i < series.length; i++) {
    const id = st.ids[labelOf(i)];
    if (id === undefined) { if (stored) note(`  ${labelOf(i)}: not created yet`); continue; }
    const p: any = await c.program.account.proposal.fetchNullable(proposalPda(id));
    if (!p) { note(`  ${labelOf(i)} #${id}: closed (deposit returned)`); continue; }
    const dl = Number(p.deadline.toString());
    note(`  ${labelOf(i)} #${id}: ${p.executed ? "EXECUTED, not closed yet" : p.votingOpen ? (now <= dl ? `voting, ${dl - now} s left` : "voting ended, not executed") : "voting not opened"} | for ${big(p.votesFor)} against ${big(p.votesAgainst)}`);
  }
  const w = await tokenAmount(c.conn, treasuryAtaOf(c.owner), TREASURY_PROGRAM);
  note(`owner's wSOL account: ${sol(w)}`);
}

// =====================================================================================================================
async function stepClaim() {
  const c = makeCtx();
  const cfg = await fetchCfg(c);
  log("--- claim: the trading fee waiting on the pool position goes into the treasury (anyone may do this; the destination is fixed in the program)");
  if (!cfg.feePool || cfg.feePool.equals(PublicKey.default)) { note("no pool is linked to this state - nothing to claim"); return; }
  const pend = await readPendingPoolFee(c.conn, cfg.feePool, cfg.feePosition);
  note(`waiting on the position: ${sol(pend.feeB)}; treasury now: ${sol(await tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM))}`);
  if (!CONFIRM) { log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front."); return; }
  execFileSync("npx", ["ts-node", "scripts/claim_pool_fees.ts"], { stdio: "inherit", env: process.env });
  note(`treasury after: ${sol(await tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM))}`);
}

// =====================================================================================================================
/** Makes sure proposal number i of the series exists (never twice, even if an answer got lost), the owner is enrolled, the voting is open and the owner voted FOR. */
async function ensureProposal(c: Ctx, i: number, n: number, amount: bigint): Promise<number> {
  const program = c.program;
  const label = labelOf(i);
  const reason = `wind-down ${i + 1}/${n}: pay ${amount} lamports of the treasury to the owner before the program is closed`;
  let st = loadState();
  let id = st.ids[label];
  if (id === undefined) {
    const cfg = await fetchCfg(c);
    const count = Number(cfg.proposalCount.toString());
    const pend = st.pending[label];
    if (pend !== undefined && count > pend) {
      const p: any = await program.account.proposal.fetchNullable(proposalPda(pend));
      if (!p || !p.creator.equals(c.owner) || p.reason !== reason) throw new Error(`proposal #${pend} exists but is not the one ${label} created - look at it before going on`);
      id = pend; note(`${label}: #${id} was created earlier (the answer was lost) - continuing`);
    } else {
      st.pending[label] = count; saveState(st);
      const sig = await program.methods.createProposal(0, c.owner, bn(amount), 0, reason)
        .accounts({ creator: c.owner, config: configPda(), governanceMint: GOVERNANCE_MINT, creatorTokenAccount: ata(c.owner), treasury: treasuryAta(), quorumExcluded: excludedAccountOf(cfg), proposal: proposalPda(count), systemProgram: SystemProgram.programId }).rpc();
      tx(`create_proposal ${label} (#${count}, ${amount} lamports)`, sig);
      id = count;
    }
    st = loadState(); st.ids[label] = id; delete st.pending[label]; saveState(st);
  }
  const pda = proposalPda(id);
  let p: any = await program.account.proposal.fetch(pda);
  if (!p.votingOpen) {
    if (!(await program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, c.owner)))) {
      const w = await tokenAmount(c.conn, ata(c.owner), TOKEN_PROGRAM);
      tx(`snapshot ${label} #${id} owner (${w} raw coins)`, await program.methods.postVoterSnapshot(bn(id), c.owner, bn(w))
        .accounts({ owner: c.owner, config: configPda(), proposal: pda, voterTokenAccount: ata(c.owner), voterSnapshot: voterSnapshotPda(pda, c.owner), systemProgram: SystemProgram.programId }).rpc());
    }
    const cfg = await fetchCfg(c);
    tx(`open_voting ${label} #${id}`, await program.methods.openVoting(bn(id))
      .accounts({ owner: c.owner, config: configPda(), governanceMint: GOVERNANCE_MINT, proposal: pda, quorumExcluded: excludedAccountOf(cfg) }).rpc());
  }
  const mine: any = await program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, c.owner));
  if (mine && !mine.consumed) {
    tx(`vote FOR ${label} #${id}`, await program.methods.vote(bn(id), true)
      .accounts({ voter: c.owner, config: configPda(), proposal: pda, voterSnapshot: voterSnapshotPda(pda, c.owner) }).rpc());
  }
  return id;
}

async function stepOpen() {
  const c = makeCtx();
  const cfg = await guardOwner(c);
  log("--- open: the series of spend proposals (each one pays a piece of the treasury to the owner wallet), the owner is the only voter");
  if (cfg.paused) throw new Error("the state is paused - unpause first");
  if (big(cfg.spendCooldownSecs) > 0n && process.env.ALLOW_COOLDOWN !== "yes") {
    throw new Error(`the pause between spends is ${cfg.spendCooldownSecs} s: the pieces could only be executed that far apart. Set ALLOW_COOLDOWN=yes only if you accept the long wait`);
  }
  const st = loadState();
  const treasury = await tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM);
  const series: bigint[] = st.done[SERIES_KEY] ? JSON.parse(st.done[SERIES_KEY]).map((x: string) => BigInt(x)) : planSeries(treasury);
  if (series.length === 0) { note(`the treasury (${sol(treasury)}) is too small to be worth a proposal`); return; }
  const q = await quorumCheck(c, cfg);
  note(`${series.length} proposals: ${series.map((x) => (Number(x) / 1e9).toFixed(6)).join(", ")} SOL`);
  note(`together ${sol(sum(series))} of ${sol(treasury)}; about ${sol(treasury - sum(series))} would stay in the treasury`);
  note(`quorum: the owner holds ${q.share} of the voting base, needs ${Number(q.qbps) / 100} % -> ${q.quorumOk ? "enough" : "NOT ENOUGH"}`);
  if (!q.quorumOk || !q.thresholdOk) throw new Error("the owner alone cannot carry the vote (quorum or creation threshold) - stop here and look at 'status'");
  const need = DEPOSIT_PER_PROPOSAL * BigInt(series.length) + 20_000_000n;
  const have = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  note(`the owner wallet has ${sol(have)}; the deposits (returned later) and fees need about ${sol(need)}`);
  if (have < need) throw new Error("the owner wallet has too little SOL for the deposits");
  if (!CONFIRM) { log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front."); return; }

  if (!st.done[SERIES_KEY]) { st.done[SERIES_KEY] = JSON.stringify(series.map((x) => x.toString())); saveState(st); }
  for (let i = 0; i < series.length; i++) await ensureProposal(c, i, series.length, series[i]);
  const now = await chainNow(c.conn);
  const lastId = loadState().ids[labelOf(series.length - 1)];
  const p: any = await c.program.account.proposal.fetch(proposalPda(lastId));
  const dl = Number(p.deadline.toString());
  log(`\nall ${series.length} proposals are open and voted FOR | the last voting window ends ${msk(dl)} (in ${Math.max(0, dl - now)} s)`);
  log("NEXT: after that time run the step 'finish'.");
}

// =====================================================================================================================
async function unwrapOwner(c: Ctx) {
  const w = treasuryAtaOf(c.owner);
  const info = await c.conn.getAccountInfo(w, "confirmed");
  if (!info) { note("the owner has no wSOL account - nothing to unwrap"); return; }
  const amt = unpackAccount(w, info, TREASURY_PROGRAM).amount;
  note(`owner's wSOL account ${w.toBase58()} holds ${sol(amt)}`);
  if (!CONFIRM) { note("would close it: the wSOL and the account's deposit turn into plain SOL on the owner wallet"); return; }
  tx("unwrap wSOL (close the owner's wSOL account)", await c.provider.sendAndConfirm(new Transaction().add(createCloseAccountInstruction(w, c.owner, c.owner, [], TREASURY_PROGRAM))));
}

async function stepFinish() {
  const c = makeCtx();
  const cfg = await guardOwner(c);
  const st = loadState();
  if (!st.done[SERIES_KEY]) throw new Error("there is no series: run the step 'open' first");
  const series: bigint[] = JSON.parse(st.done[SERIES_KEY]).map((x: string) => BigInt(x));
  const program = c.program;
  log(`--- finish: ${series.length} proposals, executed in order`);
  const before = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  const timelock = Number(cfg.timelockSecs.toString());
  let allDone = true;
  for (let i = 0; i < series.length; i++) {
    const label = labelOf(i);
    const id = loadState().ids[label];
    if (id === undefined) { note(`${label}: was never created - run the step 'open' again`); allDone = false; break; }
    const pda = proposalPda(id);
    let p: any = await program.account.proposal.fetchNullable(pda);
    if (!p) continue; // closed already
    const now = await chainNow(c.conn);
    const dl = Number(p.deadline.toString());
    if (!p.votingOpen || now <= dl) { note(`${label} #${id}: the voting is still running (${Math.max(0, dl - now)} s left, ends ${msk(dl)}) - run this step again after that`); allDone = false; break; }
    if (!p.executed) {
      if (now <= dl + timelock) { note(`${label} #${id}: the waiting time (timelock) is not over yet - run this step again in a moment`); allDone = false; break; }
      if (!CONFIRM) { note(`would execute ${label} #${id}: ${sol(series[i])} to the owner as wSOL`); allDone = false; continue; }
      try {
        tx(`execute ${label} #${id}`, await program.methods.executeProposal(bn(id))
          .accounts({ executor: c.owner, config: configPda(), treasuryMint: TREASURY_MINT, proposal: pda, treasury: treasuryAta(), recipientTokenAccount: treasuryAtaOf(c.owner), milestoneFund: null, tokenProgram: TREASURY_PROGRAM })
          .preInstructions([createAssociatedTokenAccountIdempotentInstruction(c.owner, treasuryAtaOf(c.owner), c.owner, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM)]).rpc());
      } catch (e: any) {
        note(`${label} #${id}: the contract did not execute it (${errCode(e)}) - the pieces must go in order, so I stop here`);
        allDone = false; break;
      }
      p = await program.account.proposal.fetch(pda);
    }
    const sPda = voterSnapshotPda(pda, c.owner);
    if (await program.account.voterSnapshot.fetchNullable(sPda)) {
      if (!CONFIRM) note(`would close the voter record of ${label}`);
      else tx(`close voter record ${label} #${id}`, await program.methods.closeVoterSnapshot(bn(id), c.owner)
        .accounts({ caller: c.owner, config: configPda(), proposal: pda, voterSnapshot: sPda, ownerRefund: cfg.ownersAuthority }).rpc());
    }
    if (p.executed) {
      if (!CONFIRM) note(`would close ${label} #${id}`);
      else tx(`close proposal ${label} #${id}`, await program.methods.closeProposal(bn(id)).accounts({ caller: c.owner, config: configPda(), proposal: pda, creator: p.creator }).rpc());
    }
  }
  if (allDone) await unwrapOwner(c);
  const left = await tokenAmount(c.conn, treasuryAta(), TREASURY_PROGRAM);
  const after = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  note(`treasury now: ${sol(left)}`);
  log(CONFIRM
    ? `owner wallet ${sol(before)} -> ${sol(after)} (${after >= before ? "+" : "-"}${sol(after >= before ? after - before : before - after)} incl. fees and deposits)${allDone ? "\nDONE: the treasury is emptied into the owner wallet." : "\nNOT FINISHED: run this step again (see the lines above)."}`
    : "\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front.");
}

// =====================================================================================================================
const EXEC_WINDOW_SECS = 30 * 86_400; // PROPOSAL_EXEC_WINDOW_SECS = ABANDONED_PROPOSAL_SECS of the contract

async function stepRent() {
  const c = makeCtx();
  const cfg = CONFIRM ? await guardOwner(c) : await fetchCfg(c); // the plan is a read-only look and may be printed by any wallet
  const program = c.program;
  const now = await chainNow(c.conn);
  log("--- rent: close every old proposal and voter record the contract allows (the deposits come back; impossible once the program is closed)");
  const props: any[] = await program.account.proposal.all();
  const snaps: any[] = await program.account.voterSnapshot.all();
  const byKey = new Map<string, any>(props.map((p) => [p.publicKey.toBase58(), p]));
  const timelock = Number(cfg.timelockSecs.toString()), fallback = Number(cfg.execFallbackSecs.toString());
  const before = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  note(`${props.length} proposals and ${snaps.length} voter records are still open`);
  let nSnap = 0, nProp = 0, skipped = 0;
  // 1) the voter records first: they can be closed once their voting has ended
  for (const s of snaps) {
    const p = byKey.get(s.account.proposal.toBase58());
    const voter: PublicKey = s.account.voter;
    if (!p) { note(`voter record ${s.publicKey.toBase58().slice(0, 8)}…: its proposal is gone, the id is unknown - skipped`); skipped++; continue; }
    const id = Number(p.account.id.toString());
    const ended = p.account.votingOpen && now > Number(p.account.deadline.toString());
    if (!ended) { note(`voter record of #${id} (${voter.toBase58().slice(0, 8)}…): the voting has not ended - skipped`); skipped++; continue; }
    if (!CONFIRM) { note(`would close the voter record of #${id} (${voter.toBase58().slice(0, 8)}…)`); nSnap++; continue; }
    try {
      tx(`close voter record #${id} ${voter.toBase58().slice(0, 8)}`, await program.methods.closeVoterSnapshot(bn(id), voter)
        .accounts({ caller: c.owner, config: configPda(), proposal: p.publicKey, voterSnapshot: s.publicKey, ownerRefund: cfg.ownersAuthority }).rpc());
      nSnap++;
    } catch (e: any) { note(`voter record of #${id}: not closed (${errCode(e)})`); skipped++; }
  }
  // 2) the proposals: executed, or expired without being executed
  for (const p of props) {
    const a = p.account;
    const id = Number(a.id.toString());
    const dl = Number(a.deadline.toString());
    const closable = a.votingOpen ? a.executed || now > dl + timelock + fallback + EXEC_WINDOW_SECS : now > Number(a.createdAt.toString()) + EXEC_WINDOW_SECS;
    if (!closable) { note(`#${id}: cannot be closed yet`); skipped++; continue; }
    if (!CONFIRM) { note(`would close proposal #${id} (${a.executed ? "executed" : "expired, never executed"})`); nProp++; continue; }
    try {
      tx(`close proposal #${id}`, await program.methods.closeProposal(bn(id)).accounts({ caller: c.owner, config: configPda(), proposal: p.publicKey, creator: a.creator }).rpc());
      nProp++;
    } catch (e: any) { note(`#${id}: not closed (${errCode(e)})`); skipped++; }
  }
  const after = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  log(CONFIRM
    ? `closed ${nSnap} voter records and ${nProp} proposals (${skipped} skipped); owner wallet ${sol(before)} -> ${sol(after)} (${after >= before ? "+" : "-"}${sol(after >= before ? after - before : before - after)} incl. fees)`
    : `\nDRY RUN: ${nSnap} voter records and ${nProp} proposals could be closed now. Run the same command with CONFIRM=yes in front.`);
}

async function main() {
  const step = process.argv[2] ?? "status";
  const steps: Record<string, () => Promise<void>> = { status: stepStatus, claim: stepClaim, open: stepOpen, finish: stepFinish, rent: stepRent };
  if (!steps[step]) throw new Error(`unknown step "${step}" - one of: ${Object.keys(steps).join(", ")}`);
  await steps[step]();
  process.exit(summary(step));
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
