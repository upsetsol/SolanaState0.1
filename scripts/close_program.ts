// CLOSES an upgradeable program for ever and returns its deposit to the recipient. IRREVERSIBLE: the program address can never be used again,
// and everything that only that program could sign for (its treasuries, locked pool positions) is stuck for ever.
//
//   ANCHOR_PROVIDER_URL=<rpc>  ANCHOR_WALLET=<upgrade authority keypair>
//   PROGRAM_ID=<the program to close>
//   RECIPIENT=<address that receives the deposit>   (optional, default = the authority wallet)
//   CONFIRM_CLOSE=<the same program address, typed again>   without it the script only prints what it would do
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
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
async function main() {
  const url = process.env.ANCHOR_PROVIDER_URL!;
  if (!url || !process.env.PROGRAM_ID) throw new Error("Set ANCHOR_PROVIDER_URL and PROGRAM_ID");
  const conn = new Connection(url, { commitment: "confirmed", fetch: retryFetch as any });
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir()), "utf8"))));
  const program = new PublicKey(process.env.PROGRAM_ID);
  const recipient = new PublicKey(process.env.RECIPIENT ?? authority.publicKey.toBase58());
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  const pd = await conn.getAccountInfo(programData, "confirmed");
  if (!pd) throw new Error("no program data account: the program is not deployed or already closed");
  const hasAuth = pd.data[12] === 1;
  const auth = hasAuth ? new PublicKey(pd.data.subarray(13, 45)) : null;
  console.log(`program         : ${program.toBase58()}`);
  console.log(`upgrade authority: ${auth ? auth.toBase58() : "NONE (immutable - cannot be closed)"}  ${auth && auth.equals(authority.publicKey) ? "(= your wallet)" : "(NOT your wallet)"}`);
  console.log(`deposit returned : ${(pd.lamports / 1e9).toFixed(6)} SOL  ->  ${recipient.toBase58()}`);
  console.log("AFTER THIS THE ADDRESS IS DEAD FOR EVER and everything the program controlled is stuck.");
  if (!auth || !auth.equals(authority.publicKey)) throw new Error("this wallet is not the upgrade authority");
  if (process.env.CONFIRM_CLOSE !== program.toBase58()) { console.log("\nDRY RUN — nothing was sent. To close: CONFIRM_CLOSE=" + program.toBase58() + " (type the address again)."); return; }
  const tx = new Transaction().add(new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([5, 0, 0, 0]), // Close
  }));
  tx.feePayer = authority.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(authority);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("close failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("block height exceeded - check the explorer before running again: " + sig);
    await sleep(700);
  }
  console.log("\nCLOSED. tx", sig, "| recipient balance now", (await conn.getBalance(recipient)) / 1e9, "SOL");
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
