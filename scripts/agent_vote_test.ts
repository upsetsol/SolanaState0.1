// "AGENT VOTE TEST" on the live Test 2 state: the OKX agent wallet gets some coins, ONE harmless proposal is opened with that wallet on its
// voter list, and the AI agent (the onchain-state skill) casts the vote. Steps (each is safe to run again: it looks at the chain first
// and does only what is missing; without CONFIRM=yes a step only prints its plan):
//   status   read-only overview: coins of the owner and of the agent wallet, the test proposal, who voted
//   send     owner -> agent wallet: coins up to AGENT_COINS (default 1 000 000 whole coins); the owner keeps at least OWNER_KEEP_COINS
//   open     create the proposal, enrol the owner and the agent from ONE read of their balances, open the voting, the owner votes FOR
//   finish   after the voting has ended: execute it if it passed, close the voter snapshots and the proposal (the deposits come back)
// Run through scripts/agent_vote_test.sh (it sets the network and the wallets). Journal: ~/agent-vote-test.log, progress: ~/agent-vote-test.state.json.

import { PublicKey, SystemProgram, Transaction, Connection } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, unpackAccount, getMint } from "@solana/spl-token";
import {
  anchor, getProvider, loadProgram, GOVERNANCE_MINT, TOKEN_PROGRAM, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM,
  configPda, treasuryAta, treasuryAtaOf, ata, proposalPda, voterSnapshotPda, excludedAccountOf, chainNow,
} from "./lib/env";
import { CONFIRM, STATE_FILE, LOG_FILE, loadState, saveState, log, tx, note, errCode, summary } from "./lib/gov2";

const AGENT = new PublicKey(process.env.AGENT_WALLET ?? "Bb5ZkHeqZ8EUEopVDX5pEceJkNMJYLcFKawtmwHNUZDq");
const AGENT_COINS = BigInt(process.env.AGENT_COINS ?? "1000000");            // whole coins the agent wallet should hold
const OWNER_KEEP_COINS = BigInt(process.env.OWNER_KEEP_COINS ?? "10000000"); // the owner keeps enough coins to create proposals and to carry the quorum
const LABEL = "TEST";
const AMOUNT = 100_000;                                                       // lamports of the harmless spend: 0.0001 SOL to the owner
const REASON = "agent vote test: pay 0.0001 SOL to the owner (harmless, only to try the AI agent skill)";

const big = (x: any): bigint => BigInt(x.toString());
const bn = (x: bigint | number): anchor.BN => new anchor.BN(x.toString());
const msk = (ts: number): string => new Date(ts * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК";
const sol = (l: bigint): string => (Number(l) / 1e9).toFixed(6) + " SOL";

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
const coinsOf = async (c: Ctx, who: PublicKey): Promise<bigint> => tokenAmount(c.conn, ata(who), TOKEN_PROGRAM);
async function unitOf(c: Ctx): Promise<{ unit: bigint; decimals: number }> {
  const m = await getMint(c.conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  return { unit: 10n ** BigInt(m.decimals), decimals: m.decimals };
}
const whole = (raw: bigint, unit: bigint): string => (Number(raw / (unit / 1000n)) / 1000).toLocaleString("en-US");

async function guardOwner(c: Ctx) {
  const cfg = await fetchCfg(c);
  if (!cfg.ownersAuthority.equals(c.owner)) throw new Error("this wallet is not the owner of the state - wrong ANCHOR_WALLET?");
  return cfg;
}

// =====================================================================================================================
async function stepStatus() {
  const c = makeCtx();
  const cfg = await fetchCfg(c);
  const now = await chainNow(c.conn);
  const { unit } = await unitOf(c);
  log(`--- status (chain time ${msk(now)}) | state file ${STATE_FILE} | journal ${LOG_FILE}`);
  note(`owner ${c.owner.toBase58()}: ${whole(await coinsOf(c, c.owner), unit)} coins, ${sol(BigInt(await c.conn.getBalance(c.owner, "confirmed")))}`);
  note(`agent ${AGENT.toBase58()}: ${whole(await coinsOf(c, AGENT), unit)} coins, ${sol(BigInt(await c.conn.getBalance(AGENT, "confirmed")))}`);
  note(`windows: voting ${cfg.votingPeriodSecs} s, timelock ${cfg.timelockSecs} s | paused: ${cfg.paused} | proposals so far: ${cfg.proposalCount}`);
  const id = loadState().ids[LABEL];
  if (id === undefined) { note("no test proposal yet (step 'open')"); return; }
  const pda = proposalPda(id);
  const p: any = await c.program.account.proposal.fetchNullable(pda);
  if (!p) { note(`test proposal #${id}: closed (deposits returned)`); return; }
  const dl = Number(p.deadline.toString());
  note(`test proposal #${id}: ${p.executed ? "EXECUTED" : p.votingOpen ? (now <= dl ? `voting, ${dl - now} s left (ends ${msk(dl)})` : "voting ended, not executed") : "voting not opened"} | for ${big(p.votesFor)} against ${big(p.votesAgainst)}`);
  for (const [name, who] of [["owner", c.owner], ["agent", AGENT]] as const) {
    const s: any = await c.program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, who));
    note(`  ${name}: ${s ? `on the voter list with ${whole(big(s.weight), unit)} coins, ${s.consumed ? "HAS VOTED" : "has not voted yet"}` : "not on the voter list (or the record was closed)"}`);
  }
  const sigs = await c.conn.getSignaturesForAddress(AGENT, { limit: 5 }, "confirmed");
  note("latest transactions of the agent wallet: " + (sigs.map((s) => `${new Date((s.blockTime ?? 0) * 1000).toISOString().slice(0, 19)}Z ${s.signature.slice(0, 12)}…${s.err ? " FAILED" : ""}`).join(" | ") || "none"));
}

// =====================================================================================================================
async function stepSend() {
  const c = makeCtx();
  await guardOwner(c);
  const { unit, decimals } = await unitOf(c);
  const want = AGENT_COINS * unit;
  const have = await coinsOf(c, AGENT);
  log(`--- send: coins for the agent wallet ${AGENT.toBase58()}`);
  if (have >= want) { note(`the agent wallet already holds ${whole(have, unit)} coins (wanted ${AGENT_COINS}) - nothing to do`); return; }
  const amount = want - have;
  const ownerCoins = await coinsOf(c, c.owner);
  if (ownerCoins - amount < OWNER_KEEP_COINS * unit) throw new Error(`the owner holds ${whole(ownerCoins, unit)} coins; sending ${whole(amount, unit)} would leave fewer than ${OWNER_KEEP_COINS}`);
  note(`owner ${whole(ownerCoins, unit)} coins -> send ${whole(amount, unit)} -> the agent wallet will hold ${whole(want, unit)}`);
  if (!CONFIRM) { log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front."); return; }
  const t = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(c.owner, ata(AGENT), AGENT, GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM),
    createTransferCheckedInstruction(ata(c.owner), GOVERNANCE_MINT, ata(AGENT), c.owner, amount, decimals, [], TOKEN_PROGRAM)
  );
  tx(`send ${whole(amount, unit)} coins to the agent wallet`, await c.provider.sendAndConfirm(t));
  note(`the agent wallet now holds ${whole(await coinsOf(c, AGENT), unit)} coins`);
}

// =====================================================================================================================
async function stepOpen() {
  const c = makeCtx();
  const cfg0 = await guardOwner(c);
  const { unit } = await unitOf(c);
  const agentCoins = await coinsOf(c, AGENT);
  log(`--- open: one harmless proposal (spend ${AMOUNT} lamports to the owner), voter list = owner + agent wallet, voting ${cfg0.votingPeriodSecs} s`);
  if (cfg0.paused) throw new Error("the state is paused - unpause first");
  if (agentCoins === 0n) throw new Error("the agent wallet holds no coins - run the step 'send' first");
  note(`agent wallet ${AGENT.toBase58()}: ${whole(agentCoins, unit)} coins (its voting weight)`);
  if (!CONFIRM) { log("\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front."); return; }

  const program = c.program;
  let st = loadState();
  let id = st.ids[LABEL];
  if (id === undefined) {
    const cfg = await fetchCfg(c);
    const count = Number(cfg.proposalCount.toString());
    const pend = st.pending[LABEL];
    if (pend !== undefined && count > pend) {
      const p: any = await program.account.proposal.fetchNullable(proposalPda(pend));
      if (!p || !p.creator.equals(c.owner) || p.reason !== REASON) throw new Error(`proposal #${pend} exists but is not the one this test created - look at it before going on`);
      id = pend; note(`#${id} was created earlier (the answer was lost) - continuing`);
    } else {
      st.pending[LABEL] = count; saveState(st);
      const sig = await program.methods.createProposal(0, c.owner, bn(AMOUNT), 0, REASON)
        .accounts({ creator: c.owner, config: configPda(), governanceMint: GOVERNANCE_MINT, creatorTokenAccount: ata(c.owner), treasury: treasuryAta(), quorumExcluded: excludedAccountOf(cfg), proposal: proposalPda(count), systemProgram: SystemProgram.programId }).rpc();
      tx(`create_proposal (#${count})`, sig);
      id = count;
    }
    st = loadState(); st.ids[LABEL] = id; delete st.pending[LABEL]; saveState(st);
  }
  const pda = proposalPda(id);
  let p: any = await program.account.proposal.fetch(pda);
  if (!p.votingOpen) {
    const voters = [{ name: "owner", pk: c.owner }, { name: "agent", pk: AGENT }];
    const infos = await c.conn.getMultipleAccountsInfo(voters.map((v) => ata(v.pk)), "confirmed"); // ONE consistent read of the balances
    for (let i = 0; i < voters.length; i++) {
      const v = voters[i];
      if (await program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, v.pk))) continue;
      const w = unpackAccount(ata(v.pk), infos[i]!, TOKEN_PROGRAM).amount;
      tx(`snapshot #${id} ${v.name} (${w} raw coins)`, await program.methods.postVoterSnapshot(bn(id), v.pk, bn(w))
        .accounts({ owner: c.owner, config: configPda(), proposal: pda, voterTokenAccount: ata(v.pk), voterSnapshot: voterSnapshotPda(pda, v.pk), systemProgram: SystemProgram.programId }).rpc());
    }
    const cfg = await fetchCfg(c);
    tx(`open_voting #${id}`, await program.methods.openVoting(bn(id))
      .accounts({ owner: c.owner, config: configPda(), governanceMint: GOVERNANCE_MINT, proposal: pda, quorumExcluded: excludedAccountOf(cfg) }).rpc());
    p = await program.account.proposal.fetch(pda);
  }
  const mine: any = await program.account.voterSnapshot.fetchNullable(voterSnapshotPda(pda, c.owner));
  if (mine && !mine.consumed) {
    tx(`vote FOR #${id} by the owner`, await program.methods.vote(bn(id), true)
      .accounts({ voter: c.owner, config: configPda(), proposal: pda, voterSnapshot: voterSnapshotPda(pda, c.owner) }).rpc());
  }
  p = await program.account.proposal.fetch(pda);
  const now = await chainNow(c.conn);
  const dl = Number(p.deadline.toString());
  log(`\nproposal #${id} is open | votes for ${big(p.votesFor)} / against ${big(p.votesAgainst)} | voting ends ${msk(dl)} (in ${Math.max(0, dl - now)} s)`);
  log(`NOW, in the Claude session of the agent wallet, type:  vote   (then:  vote FOR on ${id}  or  vote AGAINST on ${id},  then: yes)`);
}

// =====================================================================================================================
async function stepFinish() {
  const c = makeCtx();
  const cfg = await guardOwner(c);
  const id = loadState().ids[LABEL];
  if (id === undefined) throw new Error("there is no test proposal: run the step 'open' first");
  const program = c.program;
  const pda = proposalPda(id);
  let p: any = await program.account.proposal.fetchNullable(pda);
  log(`--- finish: test proposal #${id}`);
  if (!p) { note("already closed - nothing to do"); return; }
  const now = await chainNow(c.conn);
  const dl = Number(p.deadline.toString());
  if (!p.votingOpen || now <= dl) { note(`the voting is still running (${Math.max(0, dl - now)} s left) - run this step again after ${msk(dl)}`); return; }
  note(`voting ended: for ${big(p.votesFor)} / against ${big(p.votesAgainst)}`);
  const before = BigInt(await c.conn.getBalance(c.owner, "confirmed"));

  if (!p.executed) {
    if (now <= dl + Number(cfg.timelockSecs.toString())) note("the waiting time (timelock) is not over yet - run this step again in a moment");
    else if (!CONFIRM) note("would execute the proposal (the owner receives 0.0001 SOL as wSOL)");
    else {
      try {
        tx(`execute #${id}`, await program.methods.executeProposal(bn(id))
          .accounts({ executor: c.owner, config: configPda(), treasuryMint: TREASURY_MINT, proposal: pda, treasury: treasuryAta(), recipientTokenAccount: treasuryAtaOf(c.owner), milestoneFund: null, tokenProgram: TREASURY_PROGRAM })
          .preInstructions([createAssociatedTokenAccountIdempotentInstruction(c.owner, treasuryAtaOf(c.owner), c.owner, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM)]).rpc());
      } catch (e: any) { note(`the contract did not execute it (${errCode(e)}) - it stays until it expires`); }
    }
    p = await program.account.proposal.fetch(pda);
  }
  for (const [name, who] of [["owner", c.owner], ["agent", AGENT]] as const) {
    const sPda = voterSnapshotPda(pda, who);
    if (!(await program.account.voterSnapshot.fetchNullable(sPda))) continue;
    if (!CONFIRM) { note(`would close the voter record of ${name}`); continue; }
    tx(`close voter record #${id} ${name}`, await program.methods.closeVoterSnapshot(bn(id), who)
      .accounts({ caller: c.owner, config: configPda(), proposal: pda, voterSnapshot: sPda, ownerRefund: cfg.ownersAuthority }).rpc());
  }
  if (p.executed) {
    if (!CONFIRM) note("would close the executed proposal");
    else tx(`close proposal #${id}`, await program.methods.closeProposal(bn(id)).accounts({ caller: c.owner, config: configPda(), proposal: pda, creator: p.creator }).rpc());
  } else note("the proposal was not executed, so it can only be closed after it expires (about 33 days) - the deposit stays locked until then");
  const after = BigInt(await c.conn.getBalance(c.owner, "confirmed"));
  log(CONFIRM ? `owner wallet ${sol(before)} -> ${sol(after)} (${after >= before ? "+" : ""}${sol(after - before)} incl. fees)` : "\nDRY RUN - nothing was sent. Run the same command with CONFIRM=yes in front.");
}

async function main() {
  const step = process.argv[2] ?? "status";
  const steps: Record<string, () => Promise<void>> = { status: stepStatus, send: stepSend, open: stepOpen, finish: stepFinish };
  if (!steps[step]) throw new Error(`unknown step "${step}" - one of: ${Object.keys(steps).join(", ")}`);
  await steps[step]();
  process.exit(summary(step));
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
