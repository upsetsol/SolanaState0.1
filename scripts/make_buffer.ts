// Creates an EMPTY upgrade buffer account (the temporary account that holds the new program bytes) without the Rust CLI,
// which often cannot reach public RPCs through the local proxy. Then scripts/upgrade_program.ts fills it chunk by chunk,
// verifies it byte by byte and (with --upgrade) swaps the program. The buffer's rent (~2.65 SOL for 520 KB) goes back to the payer on upgrade.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<upgrade authority keypair> BUFFER_KEYPAIR=<where to save the new buffer keypair> \
//   SO=target/deploy/onchain_state_solana.so  CONFIRM=yes  npx ts-node scripts/make_buffer.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
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
  if (!url || !process.env.BUFFER_KEYPAIR) throw new Error("Set ANCHOR_PROVIDER_URL and BUFFER_KEYPAIR");
  const conn = new Connection(url, { commitment: "confirmed", fetch: retryFetch as any });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync((process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace("~", os.homedir()), "utf8"))));
  const so = fs.readFileSync(process.env.SO ?? "target/deploy/onchain_state_solana.so");
  const size = 37 + so.length;
  const rent = await conn.getMinimumBalanceForRentExemption(size);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`program file ${so.length} bytes -> buffer account ${size} bytes, rent ${(rent / 1e9).toFixed(4)} SOL (refunded when the upgrade is done); payer ${payer.publicKey.toBase58()} has ${(bal / 1e9).toFixed(4)} SOL`);
  if (bal < rent + 20_000_000) throw new Error("not enough SOL for the buffer rent");
  if (process.env.CONFIRM !== "yes") { console.log("DRY RUN — run again with CONFIRM=yes"); return; }
  if (fs.existsSync(process.env.BUFFER_KEYPAIR)) throw new Error("BUFFER_KEYPAIR file already exists - refusing to overwrite");
  const buffer = Keypair.generate();
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey, lamports: rent, space: size, programId: LOADER }),
    new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([0, 0, 0, 0]) }) // InitializeBuffer (authority = payer)
  );
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, buffer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  fs.writeFileSync(process.env.BUFFER_KEYPAIR, JSON.stringify(Array.from(buffer.secretKey)), { mode: 0o600 });
  console.log("buffer created:", buffer.publicKey.toBase58(), "tx", sig, "\nkeypair saved to", process.env.BUFFER_KEYPAIR);
  void SYSVAR_RENT_PUBKEY;
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
