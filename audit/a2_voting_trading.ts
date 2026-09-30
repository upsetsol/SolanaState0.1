// A2 — voting integrity and buy/sell abuse.  Attacks that a trader / holder can run WITHOUT the owner's key.
// The v4.1 voting order:  propose → the owner posts snapshots with the weights of ONE scan (weight ≤ balance right now)
// → open_voting (starts the clock, freezes the quorum base) → votes → execute.
// "EXPLOITABLE" = the attack achieved its goal on the real bytecode.  {FIXED} = it worked against v4 (audit/results_v4/)
// and v4.1 stops it; {ACCEPTED}/{PENDING} = it still works and that was decided / is still to be decided.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a2_voting_trading.ts
import { Transaction } from "@solana/web3.js";
import { createMintToInstruction } from "@solana/spl-token";
import { makeWorld, group, record, recordFixed, recordKnown, attempt, expectBlocked, TP, COIN, SOL, finish, sendSigned } from "./lib";

const coins = (n: bigint) => n / COIN;
const fmtSol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

async function main() {
  group("A2 voting integrity + trading");
  const QBPS = 300n; // quorum(spend) 3%
  const w = await makeWorld({ name: "a2", params: { cooldown: 0, vote: 14, timelock: 6, quorumSpendBps: Number(QBPS) } });
  const A = await w.holder(200_000_000n, 20); // the attacker's real stack: 20%
  const B = await w.holder(60_000_000n, 20); // honest, 6%
  const D = await w.holder(150_000_000n, 20); // honest, 15%
  await w.seedTreasury(5n * SOL);
  await w.withPool(300_000_000n, 30n * SOL);

  // live "does this many votes clear the quorum right now?" — the pre-v4.1 rule (v4.1 measures against the base frozen at open_voting)
  const baseNow = async () => (await w.supplyNow()) - (await w.bal(await w.poolVaultA()));
  const quorumMetNow = async (votes: bigint) => votes * 10_000n >= (await baseNow()) * QBPS;
  /** ONE scan of the holders' balances: what the owner's tool sees at a single moment (the site does this with one getProgramAccounts call) */
  const scan = async (ks: { publicKey: any }[]) => Promise.all(ks.map((k) => w.bal(w.ata(k.publicKey))));
  const share = (f: bigint) => `${coins(f) / 1_000_000n}M`;

  const base0 = await baseNow();
  record("A2.0", "world: 1B coins, 30% in the pool, quorum(spend)=3% of the voting base", "INFO", `base=${coins(base0)} coins, quorum=${coins((base0 * QBPS) / 10_000n)} coins`);

  // ------------------------------------------------------------------------------------------------
  // A2.1  wallet hopping: the SAME 200M coins slipped from wallet to wallet between two owner transactions
  // ------------------------------------------------------------------------------------------------
  const A2 = await w.holder(0n, 5);
  const A3 = await w.holder(0n, 5); // ends up holding A's 200M after the hops
  {
    const [wA, wA2, wA3, wB, wD] = await scan([A, A2, A3, B, D]); // ONE scan: 200M, 0, 0, 60M, 150M
    const p = await w.propose(0, A.publicKey, SOL / 50n, 0, "pay A 0.02 SOL");
    await w.snapshot(p.id, p.pPda, A.publicKey, w.payer, undefined, wA); // weight 200M
    await w.transferCoins(A, A2.publicKey, 200_000_000n); // …the attacker slips a transfer between two owner transactions
    const r2 = await attempt(() => w.snapshot(p.id, p.pPda, A2.publicKey, w.payer, undefined, wA2)); // the scan saw 0 in this wallet
    await w.transferCoins(A2, A3.publicKey, 200_000_000n);
    const r3 = await attempt(() => w.snapshot(p.id, p.pPda, A3.publicKey, w.payer, undefined, wA3));
    await w.snapshot(p.id, p.pPda, B.publicKey, w.payer, undefined, wB);
    await w.snapshot(p.id, p.pPda, D.publicKey, w.payer, undefined, wD);
    await w.openVoting(p.id);
    await w.vote(A, p.id, p.pPda, true);
    await w.vote(B, p.id, p.pPda, false);
    await w.vote(D, p.id, p.pPda, false);
    await expectBlocked("A2.1b", "the hop wallets were never enrolled (their scan weight is 0) → they cannot vote", ["AccountNotInitialized", "3012"], async () => {
      await w.vote(A2, p.id, p.pPda, true);
    });
    const pr = await w.proposalOf(p.pPda);
    const f = BigInt(pr.votesFor.toString()), ag = BigInt(pr.votesAgainst.toString());
    await w.waitExecutable(p.pPda);
    const ex = await attempt(() => w.execute(p.id, { recipient: w.tAta(A.publicKey) }));
    recordFixed(
      "A2.1",
      "wallet hopping between two owner snapshot transactions (the owner posts the weights of ONE scan): 200M real coins voted three times",
      ex.ok || f > 200_000_000n * COIN,
      `counted for=${share(f)} vs against=${share(ag)} (A really owns 200M; honest tally 200M vs 210M = REJECTED); posting weight 0 for the hop wallets → NoWeight (${/NoWeight/.test(r2.err)}/${/NoWeight/.test(r3.err)}); executed=${ex.ok}`
    );
  }

  // A2.1r  the RESIDUAL: an owner who posts each wallet's LIVE balance one by one (what the old site did) is still fooled.
  // The sum check in open_voting (Σ weights ≤ supply) only caps the multiplier at supply / real stack.
  {
    const p = await w.propose(0, A3.publicKey, SOL / 50n, 0, "pay A3 0.02 SOL (live balances)");
    await w.snapshot(p.id, p.pPda, A3.publicKey); // live 200M
    await w.transferCoins(A3, A.publicKey, 200_000_000n);
    await w.snapshot(p.id, p.pPda, A.publicKey); // live 200M again
    await w.transferCoins(A, A2.publicKey, 200_000_000n);
    await w.snapshot(p.id, p.pPda, A2.publicKey); // and again
    await w.snapshot(p.id, p.pPda, B.publicKey);
    await w.snapshot(p.id, p.pPda, D.publicKey);
    await w.openVoting(p.id); // Σ weights = 810M ≤ 1B supply → accepted
    for (const k of [A3, A, A2]) await w.vote(k, p.id, p.pPda, true);
    await w.vote(B, p.id, p.pPda, false);
    await w.vote(D, p.id, p.pPda, false);
    const pr = await w.proposalOf(p.pPda);
    const f = BigInt(pr.votesFor.toString()), ag = BigInt(pr.votesAgainst.toString());
    await w.waitExecutable(p.pPda);
    const ex = await attempt(() => w.execute(p.id, { recipient: w.tAta(A3.publicKey) }));
    recordKnown(
      "A2.1r",
      "RESIDUAL: the owner posts LIVE balances one by one instead of the weights of one scan → the same hop still counts 200M three times",
      ex.ok,
      "ACCEPTED",
      `counted for=${share(f)} vs against=${share(ag)} (real 200M vs 210M → should be REJECTED); executed=${ex.ok}. Needs an owner who ignores the scan-based tools (site: «Внести всем (один скан)», scripts/snapshot_all.ts)`
    );
  }

  // A2.1c  control for A2.1r: the same three actors, NO hopping → the proposal is rejected, as the honest tally says
  {
    const c = await w.propose(0, A2.publicKey, SOL / 50n, 0, "control: same vote without hopping");
    for (const k of [A2, B, D]) await w.snapshot(c.id, c.pPda, k.publicKey);
    await w.openVoting(c.id);
    await w.vote(A2, c.id, c.pPda, true);
    await w.vote(B, c.id, c.pPda, false);
    await w.vote(D, c.id, c.pPda, false);
    await w.waitExecutable(c.pPda);
    const ex = await attempt(() => w.execute(c.id, { recipient: w.tAta(A2.publicKey) }));
    const rejected = !ex.ok && /ProposalRejected/.test(ex.err);
    record("A2.1c", "control: without hopping the same 200M-vs-210M vote is REJECTED (so the hop is what flipped A2.1r)", rejected ? "OK" : "ERROR", `rejected=${rejected}`);
  }

  // A2.1d  a stale scan: the coins left the wallet between the owner's scan and the owner's transaction
  {
    const st = await w.propose(0, w.me, 1000n, 0, "stale-scan test");
    const [scanned] = await scan([A2]); // 200M at scan time
    await w.transferCoins(A2, A3.publicKey, 200_000_000n); // …then the coins move on
    await expectBlocked("A2.1d", "stale scan: the coins left the wallet before the owner posted its weight → the weight is refused", "WeightExceedsBalance", async () => {
      await w.snapshot(st.id, st.pPda, A2.publicKey, w.payer, undefined, scanned);
    });
  }

  // ------------------------------------------------------------------------------------------------
  // A2.2  electorate lock-out: the first enrolled voter votes at once so nobody else can be added
  // ------------------------------------------------------------------------------------------------
  const Aw = await w.holder(200_000_000n, 20); // a fresh 20% whale (the hops above moved A's coins away)
  {
    const q = await w.propose(0, Aw.publicKey, SOL / 2n, 0, "pay 0.5 SOL (lock-out)");
    await w.snapshot(q.id, q.pPda, Aw.publicKey);
    const early = await attempt(() => w.vote(Aw, q.id, q.pPda, true)); // the old exploit: vote the moment your snapshot exists
    // in v4 this locked D (15%) and B (6%) out for good; in v4.1 the enrolment stays open until the owner calls open_voting
    await w.snapshot(q.id, q.pPda, D.publicKey);
    await w.snapshot(q.id, q.pPda, B.publicKey);
    await w.openVoting(q.id);
    await expectBlocked("A2.2b", "after open_voting no further voter can be enrolled (so the owner has to enrol everybody first)", "VotingAlreadyOpen", async () => {
      await w.snapshot(q.id, q.pPda, A3.publicKey);
    });
    await w.vote(Aw, q.id, q.pPda, true);
    await w.vote(D, q.id, q.pPda, false);
    await w.vote(B, q.id, q.pPda, false);
    await w.waitExecutable(q.pPda);
    const ex = await attempt(() => w.execute(q.id, { recipient: w.tAta(Aw.publicKey) }));
    if (!early.ok && !/VotingNotOpen/.test(early.err)) record("A2.2", "electorate lock-out", "ERROR", "the early vote failed with something unexpected: " + early.err.slice(0, 200));
    else recordFixed("A2.2", "electorate lock-out: the first enrolled voter tries to vote at once → VotingNotOpen; D (15%) and B (6%) can still be enrolled", early.ok, `early vote accepted=${early.ok}; proposal (0.5 SOL out of the treasury) executed=${ex.ok}`);
    const rejected = !ex.ok && /ProposalRejected/.test(ex.err);
    record("A2.2c", "control: with the whole electorate enrolled first, the 200M-vs-210M vote is REJECTED", rejected ? "OK" : "ERROR", `rejected=${rejected}`);
  }

  // ------------------------------------------------------------------------------------------------
  // A2.3  vote rental: buy in the pool → owner posts the snapshot → sell everything → vote
  // ------------------------------------------------------------------------------------------------
  {
    const X = await w.holder(0n, 200);
    const v0 = await w.solOf(X.publicKey);
    await w.swap(X, "buy", 8n * SOL);
    const held = await w.bal(w.ata(X.publicKey));
    const r = await w.propose(0, w.me, 1000n, 0, "rent-a-vote test");
    await w.snapshot(r.id, r.pPda, X.publicKey); // the scan sees the coins he holds right now
    await w.swap(X, "sell", coins(held));
    const left = await w.bal(w.ata(X.publicKey));
    await w.openVoting(r.id);
    await w.vote(X, r.id, r.pPda, true);
    const v1 = await w.solOf(X.publicKey);
    const pr = await w.proposalOf(r.pPda);
    const vf = BigInt(pr.votesFor.toString());
    const cost = v0 - v1;
    recordKnown(
      "A2.3",
      "buy → owner snapshots → sell everything → still votes with the full weight",
      vf >= held - COIN && left < COIN,
      "ACCEPTED",
      `weight counted=${share(vf)} coins (${(Number(vf) / Number(w.supply) * 100).toFixed(2)}% of supply) while he holds ${(Number(left) / 1e9).toFixed(3)} coins afterwards. Cost of renting them = ${fmtSol(cost)} SOL (${(Number(cost) / 8e9 * 100).toFixed(1)}% of the 8 SOL he spent buying; both 5% fees + slippage)`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.4  quorum veto through the pool: a passed vote is blocked by buying coins out of the pool
  // ------------------------------------------------------------------------------------------------
  {
    const base = await baseNow();
    const quorum = (base * QBPS) / 10_000n; // base units
    const weight = coins(quorum) + 100_000n; // 0.1M coins above the bar (~0.5% margin)
    const Dq = await w.holder(weight, 5);
    const s = await w.propose(0, w.me, 1000n, 0, "quorum-veto test");
    await w.snapshot(s.id, s.pPda, Dq.publicKey);
    await w.openVoting(s.id); // the quorum base is frozen HERE
    await w.vote(Dq, s.id, s.pPda, true);
    await w.waitExecutable(s.pPda);
    const Y = await w.holder(0n, 200);
    const v0 = await w.solOf(Y.publicKey);
    // buy coins out of the pool until the vote would no longer clear the LIVE quorum (the pre-v4.1 rule)
    let buys = 0;
    while (await quorumMetNow(weight * COIN)) {
      await w.swap(Y, "buy", SOL / 4n);
      if (++buys > 20) throw new Error("could not push the base far enough");
    }
    const held = await w.bal(w.ata(Y.publicKey));
    const liveBase = await baseNow();
    const ex = await attempt(() => w.execute(s.id, { recipient: w.tAta(w.me) }));
    await w.swap(Y, "sell", coins(held));
    const v1 = await w.solOf(Y.publicKey);
    recordFixed(
      "A2.4",
      "quorum veto: after the vote passed, a trader BUYS coins out of the pool (the live base grows past the vote's quorum)",
      !ex.ok,
      `voter had ${weight} coins vs quorum ${coins(quorum)} (margin 0.5%); the attacker pulled ${coins(held)} coins (${(Number(held) / Number(base) * 100).toFixed(2)}% of the base) out of the pool, live base ${coins(base)} → ${coins(liveBase)}; the buys cost him ${fmtSol(v0 - v1)} SOL; execute with the frozen base: ok=${ex.ok}${ex.ok ? "" : " " + ex.err.slice(0, 120)}`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.5  the reverse: a proposal short of quorum is pushed over the line by DUMPING coins into the pool
  // ------------------------------------------------------------------------------------------------
  {
    const base = await baseNow();
    const quorum = (base * QBPS) / 10_000n;
    const weight = coins(quorum) - 50_000n; // 0.05M coins SHORT of quorum
    const D2 = await w.holder(weight, 5);
    const S = await w.holder(3_000_000n, 50); // a seller with 3M coins
    const s = await w.propose(0, w.me, 1000n, 0, "quorum-push test");
    await w.snapshot(s.id, s.pPda, D2.publicKey);
    await w.openVoting(s.id);
    await w.vote(D2, s.id, s.pPda, true);
    await w.waitExecutable(s.pPda);
    const before = await attempt(() => w.execute(s.id, { recipient: w.tAta(w.me) }));
    const shortBefore = !before.ok && /QuorumNotReached/.test(before.err);
    await w.swap(S, "sell", 3_000_000n);
    const metLive = await quorumMetNow(weight * COIN);
    const after = await attempt(() => w.execute(s.id, { recipient: w.tAta(w.me) }));
    if (!shortBefore) record("A2.5", "quorum push", "ERROR", "the control failed: the proposal was not short of quorum before the dump: " + before.err.slice(0, 160));
    else recordFixed(
      "A2.5",
      "quorum push: proposal is 0.05M coins short; a holder SELLS 3M coins into the pool → the live base shrinks",
      after.ok,
      `short of quorum before=${shortBefore}; the pre-v4.1 live rule WOULD be met after the dump=${metLive}; with the frozen base executed=${after.ok}`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.5b what still counts: the base is frozen AT open_voting, so a trade just BEFORE it moves it (by design)
  // ------------------------------------------------------------------------------------------------
  {
    const Z = await w.holder(0n, 100);
    const s = await w.propose(0, w.me, 1000n, 0, "base-at-open test");
    await w.snapshot(s.id, s.pPda, D.publicKey);
    const b0 = await baseNow();
    await w.swap(Z, "buy", SOL / 4n); // a trade before the opening…
    const b1 = await baseNow();
    await w.openVoting(s.id);
    const frozen = BigInt((await w.proposalOf(s.pPda)).baseAtOpen.toString());
    await w.swap(Z, "buy", SOL / 4n); // …and one after it
    const b2 = await baseNow();
    const frozenAfter = BigInt((await w.proposalOf(s.pPda)).baseAtOpen.toString());
    record(
      "A2.5b",
      "measurement: the frozen base is the base AT the moment of open_voting (a trade just before it counts, a trade after it does not)",
      frozen === b1 && frozenAfter === frozen ? "INFO" : "ERROR",
      `base ${coins(b0)} → ${coins(b1)} after a buy before the opening; frozen at open=${coins(frozen)}; a second buy after the opening moved the live base to ${coins(b2)} but the frozen base stays ${coins(frozenAfter)}. The owner can look at the pool right before pressing «Начать голосование»; a trader would have to hit the same block, and pays the 5% fee on the volume`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.6  proposal threshold with borrowed coins: buy → create proposal → sell
  // ------------------------------------------------------------------------------------------------
  {
    const X2 = await w.holder(0n, 200);
    const v0 = await w.solOf(X2.publicKey);
    await w.swap(X2, "buy", 2n * SOL); // ≈ 1.3% of supply (> 1% of the base)
    const cr = await attempt(() => w.propose(0, X2.publicKey, (5n * SOL * 20n) / 100n, 0, "flash proposer", X2));
    const held = await w.bal(w.ata(X2.publicKey));
    await w.swap(X2, "sell", coins(held));
    const left = await w.bal(w.ata(X2.publicKey));
    const v1 = await w.solOf(X2.publicKey);
    recordKnown(
      "A2.6",
      "create a proposal with coins that are sold right afterwards (threshold is checked on the LIVE balance)",
      cr.ok && left < COIN,
      "ACCEPTED",
      `created=${cr.ok} ${cr.err.slice(0, 160)}; holds ${(Number(left) / 1e9).toFixed(3)} coins afterwards; total cost incl. rent and both 5% fees=${fmtSol(v0 - v1)} SOL. Creating a proposal executes nothing: it still needs the owner's enrolment and a majority`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.7  the MINT AUTHORITY: minting after open_voting no longer moves the quorum (base frozen), but a minter can still
  //       print coins BEFORE the vote and enrol himself
  // ------------------------------------------------------------------------------------------------
  {
    const t = await w.propose(0, w.me, 1000n, 0, "mint-authority veto test");
    await w.snapshot(t.id, t.pPda, Aw.publicKey);
    await w.openVoting(t.id);
    await w.vote(Aw, t.id, t.pPda, true);
    await w.waitExecutable(t.pPda);
    const before = await w.supplyNow();
    await sendSigned(new Transaction().add(createMintToInstruction(w.mint.publicKey, w.myAta, w.me, 10_000_000_000n * COIN, [], TP)), [w.payer]);
    const after = await w.supplyNow();
    const ex = await attempt(() => w.execute(t.id, { recipient: w.tAta(w.me) }));
    recordFixed(
      "A2.7",
      "mint authority still alive: minting 10B new coins AFTER the vote started (used to make a passed proposal fail its quorum)",
      !ex.ok,
      `supply ${coins(before)} → ${coins(after)} coins; execute with the frozen base: ok=${ex.ok}${ex.ok ? "" : " " + ex.err.slice(0, 120)}`
    );
  }
  {
    // the minter (here: the deployer = owner) already holds the printed 10B; the WHOLE real electorate is enrolled too and votes against
    const u = await w.propose(0, w.me, SOL / 10n, 0, "print-then-vote");
    await w.snapshot(u.id, u.pPda, w.me);
    await w.snapshot(u.id, u.pPda, D.publicKey);
    await w.snapshot(u.id, u.pPda, B.publicKey);
    await w.openVoting(u.id);
    await w.vote(w.payer, u.id, u.pPda, true);
    await w.vote(D, u.id, u.pPda, false);
    await w.vote(B, u.id, u.pPda, false);
    await w.waitExecutable(u.pPda);
    const ex = await attempt(() => w.execute(u.id, { recipient: w.tAta(w.me) }));
    recordKnown(
      "A2.7b",
      "mint authority still alive: coins printed BEFORE the vote + self-enrolment outvote the whole real electorate",
      ex.ok,
      "PENDING",
      `executed=${ex.ok}${ex.ok ? "" : " " + ex.err.slice(0, 120)}. Closed only by the launch procedure (revoke the mint authority after the initial distribution); the contract does not require it — Nikita's decision on the mint authority is still open`
    );
  }

  finish("audit/results_a2.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
