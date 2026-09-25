// Resumable UPGRADE of an already deployed program over a flaky RPC (used on devnet when `solana program deploy`
// kept stalling on the public endpoint). It never spends anything by itself except transaction fees:
//   1. the buffer (a temporary account holding the new program bytes) must already exist. Create it once with
//      `solana program write-buffer <so> --buffer <keypair.json> ...` (the CLI may stall near the end, that is fine);
//   2. this script compares the buffer with the local .so chunk by chunk and re-writes only the missing chunks
//      (safe to run again and again), then verifies the buffer is byte-identical to the .so;
//   3. with --upgrade it swaps the program to the verified buffer; the buffer's rent goes back to the payer.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<upgrade authority keypair> BUFFER_KEYPAIR=<buffer keypair.json> \
//   PROGRAM_ID=<program> SO=target/deploy/onchain_state_solana.so npx ts-node scripts/upgrade_program.ts [--upgrade]
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import { readIdl } from "./lib/idl";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? readIdl().address);
const [PROGRAM_DATA] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER);
const url = process.env.ANCHOR_PROVIDER_URL!;
if (!url || !process.env.BUFFER_KEYPAIR) throw new Error("Set ANCHOR_PROVIDER_URL and BUFFER_KEYPAIR (see the header of this file).");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retryFetch(input: any, init?: any): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, { ...(init || {}), signal: AbortSignal.timeout(30000) });
      if ((r.status === 429 || r.status >= 500) && i < 20) { await sleep(1000 * Math.min(i + 1, 8)); continue; }
      return r;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(1000 * Math.min(i + 1, 8));
    }
  }
}
const conn = new Connection(url, { commitment: "confirmed", fetch: retryFetch as any });
const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
const buffer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.BUFFER_KEYPAIR!, "utf8"))));
const so = fs.readFileSync(process.env.SO ?? "target/deploy/onchain_state_solana.so");
const CHUNK = 900;

async function send(ix: TransactionInstruction) {
  for (let i = 0; ; i++) {
    try {
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(payer);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      return sig;
    } catch (e: any) {
      if (i < 12) { await sleep(1500); continue; }
      throw e;
    }
  }
}

async function main() {
  console.log("reading the buffer...");
  const info = await conn.getAccountInfo(buffer.publicKey, "confirmed");
  if (!info) throw new Error("buffer account not found");
  console.log("buffer read:", info.data.length, "bytes");
  const data = info.data.subarray(37);
  let fixed = 0;
  for (let off = 0; off < so.length; off += CHUNK) {
    const want = so.subarray(off, Math.min(off + CHUNK, so.length));
    const have = data.subarray(off, off + want.length);
    if (Buffer.compare(Buffer.from(want), Buffer.from(have)) === 0) continue;
    const hdr = Buffer.alloc(4 + 4 + 8);
    hdr.writeUInt32LE(1, 0); // Write
    hdr.writeUInt32LE(off, 4);
    hdr.writeBigUInt64LE(BigInt(want.length), 8);
    await send(new TransactionInstruction({
      programId: LOADER,
      keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.concat([hdr, Buffer.from(want)]),
    }));
    fixed++;
    console.log("rewrote chunk at", off);
  }
  const check = (await conn.getAccountInfo(buffer.publicKey, "confirmed"))!.data.subarray(37, 37 + so.length);
  const same = Buffer.compare(Buffer.from(check), Buffer.from(so)) === 0;
  console.log(`fixed ${fixed} chunk(s); buffer identical to the .so: ${same}`);
  if (same && process.argv.includes("--upgrade")) {
    const sig = await send(new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: PROGRAM_DATA, isSigner: false, isWritable: true },
        { pubkey: PROGRAM, isSigner: false, isWritable: true },
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: false, isWritable: true }, // spill: gets the buffer's rent back
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 0, 0, 0]), // Upgrade
    }));
    console.log("UPGRADED, tx", sig);
  }
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
