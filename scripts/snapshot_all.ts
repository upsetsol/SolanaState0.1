// The owner's console flow for ONE vote:  scan all holders ONCE  →  post exactly those weights  →  open the voting.
//
// Why one scan: the weights must all describe the same moment. If a holder moves coins to another wallet while you are
// still posting, the other wallet's weight is what it held at scan time (0 or dust), so the same coins are never counted
// twice. The program refuses a weight above the balance the voter has when you post it (that holder is reported below —
// look at them before you open the voting).
//
//   GOVERNANCE_MINT=<mint>   KEYPAIR=<owners_authority keypair>   PROPOSAL_ID=<id>
//   MIN_WEIGHT=<raw units>   optional: skip holders below this (dust)
//   OPEN=1                   optional: also call open_voting when every snapshot is posted
//
// Coins in the pool vault and in state-owned accounts are skipped (they can't vote). If a holder keeps coins in several token
// accounts, only the largest one counts — ask them to consolidate first.

import { getMint, unpackAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, GOVERNANCE_MINT, configPda, proposalPda, postSnapshot, openVoting, METEORA_POOL_AUTHORITY } from "./lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const conn = provider.connection;
  const proposalId = process.env.PROPOSAL_ID;
  if (!proposalId) throw new Error("Set PROPOSAL_ID.");
  const minWeight = BigInt(process.env.MIN_WEIGHT ?? "1");

  const pr: any = await program.account.proposal.fetch(proposalPda(proposalId));
  if (pr.votingOpen) throw new Error("Voting is already open for this proposal: no more snapshots can be added.");

  // ---- ONE scan (a single RPC answer = one consistent view of all balances)
  const raw = await conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: GOVERNANCE_MINT.toBase58() } }],
  });
  const best = new Map<string, { owner: PublicKey; account: PublicKey; amount: bigint }>();
  for (const a of raw) {
    try {
      const u = unpackAccount(a.pubkey, a.account, TOKEN_2022_PROGRAM_ID);
      if (!u.mint.equals(GOVERNANCE_MINT) || u.amount < minWeight) continue;
      if (u.owner.equals(configPda()) || u.owner.equals(METEORA_POOL_AUTHORITY)) continue;
      const k = u.owner.toBase58();
      const cur = best.get(k);
      if (!cur || u.amount > cur.amount) best.set(k, { owner: u.owner, account: a.pubkey, amount: u.amount });
    } catch { /* not a token account */ }
  }
  const holders = [...best.values()].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  const supply = (await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const scanTotal = holders.reduce((s, h) => s + h.amount, 0n);
  console.log(`scan: ${holders.length} holders, total weight ${scanTotal} of supply ${supply}`);

  // ---- post exactly the scanned weights
  let posted = 0n, ok = 0;
  for (const h of holders) {
    try {
      const exists = await program.account.voterSnapshot.fetchNullable(
        PublicKey.findProgramAddressSync([Buffer.from("voter_snapshot"), proposalPda(proposalId).toBuffer(), h.owner.toBuffer()], program.programId)[0]
      );
      if (exists) { console.log("  already posted:", h.owner.toBase58()); continue; }
      await postSnapshot(program, provider, proposalId, h.owner, h.amount, h.account);
      posted += h.amount; ok++;
      console.log(`  posted ${h.owner.toBase58()}  weight ${h.amount}`);
    } catch (e: any) {
      const msg = e.error?.errorCode?.code ?? e.message;
      console.log(`  ❗ NOT posted ${h.owner.toBase58()} (weight ${h.amount}): ${msg}${msg === "WeightExceedsBalance" ? "  ← this holder moved coins after the scan; look before opening" : ""}`);
    }
  }
  console.log(`\nposted ${ok} snapshots, weight ${posted} (${(Number(posted) * 100 / Number(supply)).toFixed(2)}% of the supply)`);

  if (process.env.OPEN === "1") {
    const sig = await openVoting(program, provider, proposalId);
    console.log("open_voting tx:", sig, "→ votes are accepted now, the quorum base is frozen");
  } else {
    console.log("Not opened. When you are happy with the list:  OPEN=1 (same command) or scripts/open_voting.ts");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
