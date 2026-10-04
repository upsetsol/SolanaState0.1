// Send SOL from one wallet to another. AMOUNT=all sends everything the wallet has (the network fee is taken out of it, the wallet ends at 0).
// Needs no governance mint: it is a plain transfer.
//   ANCHOR_PROVIDER_URL=<rpc>  KEYPAIR=~/sender.json (or ANCHOR_WALLET)  TO=<address>  AMOUNT=<SOL | all>  CONFIRM=yes (without it: dry run)
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const FEE_LAMPORTS = 5000n; // one signature; there is no priority fee in this transaction
const MIN_WALLET = 890_880n; // the rent-exempt minimum of an empty wallet: a wallet cannot hold less than this (except exactly 0)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retryFetch(input: any, init?: any): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, { ...(init || {}), signal: AbortSignal.timeout(30000) });
      if ((r.status === 429 || r.status >= 500) && i < 20) { await sleep(1000 * Math.min(i + 1, 8)); continue; }
      return r;
    } catch (e) { if (i >= 20) throw e; await sleep(1000 * Math.min(i + 1, 8)); }
  }
}
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(9);

async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL;
  if (!url) throw new Error("set ANCHOR_PROVIDER_URL");
  if (!process.env.TO) throw new Error("set TO=<address that receives the SOL>");
  const keyFile = (process.env.KEYPAIR ?? process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(/^~/, os.homedir());
  const sender = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8"))));
  const conn = new Connection(url, { commitment: "confirmed", fetch: retryFetch as any });
  const me = sender.publicKey;
  const to = new PublicKey(process.env.TO);
  if (to.equals(me)) throw new Error("TO is the sender itself");
  const raw = (process.env.AMOUNT ?? "").trim().toLowerCase();
  const bal = BigInt(await conn.getBalance(me, "confirmed"));
  const toBal = BigInt(await conn.getBalance(to, "confirmed"));
  let amount: bigint;
  if (raw === "all") amount = bal - FEE_LAMPORTS;
  else {
    if (!/^\d+(\.\d{1,9})?$/.test(raw)) throw new Error("set AMOUNT=<SOL, e.g. 0.25> or AMOUNT=all");
    const [w, f = ""] = raw.split(".");
    amount = BigInt(w) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
  }
  console.log(`from ${me.toBase58()}  (has ${sol(bal)} SOL)\nto   ${to.toBase58()}  (has ${sol(toBal)} SOL)\nsend ${sol(amount)} SOL, network fee ${sol(FEE_LAMPORTS)} SOL`);
  if (amount <= 0n) throw new Error("nothing to send");
  if (bal < amount + FEE_LAMPORTS) throw new Error("not enough SOL on the sender");
  const left = bal - amount - FEE_LAMPORTS;
  if (left !== 0n && left < MIN_WALLET) throw new Error(`the sender would be left with ${sol(left)} SOL — below the minimum a wallet can hold (${sol(MIN_WALLET)}); send less or use AMOUNT=all`);
  if (toBal === 0n && amount < MIN_WALLET) throw new Error(`the recipient is empty; the first transfer must be at least ${sol(MIN_WALLET)} SOL`);
  console.log(`afterwards: sender ${sol(left)} SOL, recipient ${sol(toBal + amount)} SOL`);
  if (process.env.CONFIRM !== "yes") { console.log("\nDRY RUN — nothing was sent. To really send, run the same command again with CONFIRM=yes in front."); return; }

  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports: amount }));
  tx.feePayer = me;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(sender);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("transfer failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("block height exceeded — check the explorer before running again: " + sig);
    await sleep(700);
  }
  console.log("\nDONE. tx", sig);
  console.log(`sender now ${sol(BigInt(await conn.getBalance(me, "confirmed")))} SOL, recipient now ${sol(BigInt(await conn.getBalance(to, "confirmed")))} SOL`);
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
