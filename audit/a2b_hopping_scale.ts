// A2b — how far does the wallet-hopping trick scale, and what does it cost?  A 4.2% holder spreads his coins over
// 10 wallets and shuttles the SAME coins to the next wallet after each owner snapshot transaction.
//   round 1: the owner posts the weights of ONE scan (v4.1 tools)            → the trick gains nothing
//   round 2: the owner posts each wallet's LIVE balance one by one (residual) → the coins are counted 10×
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a2b_hopping_scale.ts
import { Keypair } from "@solana/web3.js";
import { makeWorld, group, record, recordFixed, recordKnown, attempt, COIN, finish, conn } from "./lib";

async function main() {
  group("A2b hopping at scale");
  const N = 10;
  const w = await makeWorld({ name: "a2b", params: { cooldown: 0, vote: 30, timelock: 5, quorumParamBps: 1500 } });
  const B = await w.holder(60_000_000n, 20);
  const D = await w.holder(150_000_000n, 20);
  const wallets: Keypair[] = [];
  for (let i = 0; i < N; i++) wallets.push(await w.holder(i === 0 ? 42_000_000n : 0n, 2)); // only wallet 0 really holds coins (4.2% of supply)
  const solOfAll = async () => (await Promise.all(wallets.map((k) => conn.getBalance(k.publicKey)))).reduce((a, b) => a + BigInt(b), 0n);
  const attackerSolBefore = await solOfAll();
  const M = (x: bigint) => `${x / COIN / 1_000_000n}M`;

  // ---- round 1: the owner posts the weights of ONE scan
  {
    // a harmless governance change: raise the finance minister's daily limit 50 → 60 bps
    const scanW = await Promise.all(wallets.map((k) => w.bal(w.ata(k.publicKey)))); // [42M, 0, 0, …, 0]
    const p = await w.propose(4, w.me, 60, 5, "hopping at scale (weights of one scan)");
    await w.snapshot(p.id, p.pPda, D.publicKey); // the site posts holders in DESCENDING balance order: D, B, then the attacker's wallets
    await w.snapshot(p.id, p.pPda, B.publicKey);
    let refused = 0;
    for (let i = 0; i < N; i++) {
      if (scanW[i] > 0n) await w.snapshot(p.id, p.pPda, wallets[i].publicKey, w.payer, undefined, scanW[i]);
      else if (/NoWeight/.test((await attempt(() => w.snapshot(p.id, p.pPda, wallets[i].publicKey, w.payer, undefined, scanW[i]))).err)) refused++;
      if (i + 1 < N) await w.transferCoins(wallets[i], wallets[i + 1].publicKey, 42_000_000n); // slipped in before the next owner tx
    }
    await w.openVoting(p.id);
    await w.vote(wallets[0], p.id, p.pPda, true); // the only wallet that has a snapshot
    await w.vote(D, p.id, p.pPda, false);
    await w.vote(B, p.id, p.pPda, false);
    const pr = await w.proposalOf(p.pPda);
    const vf = BigInt(pr.votesFor.toString()), va = BigInt(pr.votesAgainst.toString());
    await w.waitExecutable(p.pPda);
    const ex = await attempt(() => w.execute(p.id));
    const cfg = await w.cfg();
    recordFixed(
      "A2b.1",
      `a 4.2% holder (42M coins) uses ${N} wallets, the owner posts the weights of ONE scan: his coins are counted once`,
      ex.ok,
      `counted for=${M(vf)} (real stack 42M) vs against=${M(va)} (honest opposition 210M) → rejected; the owner's attempts to enrol the ${N - 1} hop wallets were refused with NoWeight: ${refused}/${N - 1}; finance_daily_bps is ${cfg.financeDailyBps} (was 50)`
    );
  }

  // ---- round 2 (residual): the coins now sit in the last wallet; hop them back down the chain, the owner posts LIVE balances
  {
    const p = await w.propose(4, w.me, 70, 5, "hopping at scale (live balances)");
    await w.snapshot(p.id, p.pPda, D.publicKey);
    await w.snapshot(p.id, p.pPda, B.publicKey);
    for (let i = N - 1; i >= 0; i--) {
      await w.snapshot(p.id, p.pPda, wallets[i].publicKey); // weight = whatever wallet i holds RIGHT NOW (42M each time)
      if (i > 0) await w.transferCoins(wallets[i], wallets[i - 1].publicKey, 42_000_000n);
    }
    await w.openVoting(p.id); // Σ weights = 630M ≤ 1B supply → accepted
    await Promise.all([...wallets.map((k) => w.vote(k, p.id, p.pPda, true)), w.vote(D, p.id, p.pPda, false), w.vote(B, p.id, p.pPda, false)]);
    const pr = await w.proposalOf(p.pPda);
    const vf = BigInt(pr.votesFor.toString()), va = BigInt(pr.votesAgainst.toString());
    await w.waitExecutable(p.pPda);
    const ex = await attempt(() => w.execute(p.id));
    const cfg = await w.cfg();
    recordKnown(
      "A2b.2",
      `RESIDUAL: the owner posts LIVE balances one by one → the same 42M coins are counted ${N}×`,
      ex.ok,
      "ACCEPTED",
      `counted for=${M(vf)} (real stack 42M) vs against=${M(va)} → passes; finance_daily_bps is now ${cfg.financeDailyBps} (was 50). The open_voting sum check (Σ weights ≤ supply) only caps the multiplier at supply / stack (≈ 23× for 4.2%)`
    );
  }
  const attackerSolAfter = await solOfAll();
  record("A2b.3", "cost of the multiplier (both rounds): SOL spent by the ten wallets (token-account rent is paid by the deployer in this harness; the rest is fees)", "INFO",
    `≈${(Number(attackerSolBefore - attackerSolAfter) / 1e9).toFixed(5)} SOL in transaction fees; plus ≈0.002 SOL rent per extra token account (${N - 1} more) → well under 0.05 SOL in total. The counter (u64) only overflows after ≈18× total supply`);
  finish("audit/results_a2b.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
