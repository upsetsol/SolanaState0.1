// Creates an EMPTY upgrade buffer account (the temporary account that holds the new program bytes) without the Rust CLI,
// which often cannot reach public RPCs through the local proxy. Then scripts/upgrade_program.ts fills it chunk by chunk,
// verifies it byte by byte and (with --upgrade) swaps the program. The buffer's rent (~2.65 SOL for 520 KB) goes back to the payer on upgrade.
//
// Safe to run again: the BUFFER_KEYPAIR file is written BEFORE the transaction is sent and is the identity of the buffer. If it already exists the
// script reuses it: when the buffer is already on chain it does nothing, when it is not (an interrupted run) it creates it. So a second 2.65 SOL buffer can never appear
// and the key of a created buffer can never be lost.
//
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<upgrade authority keypair> BUFFER_KEYPAIR=<where to save the new buffer keypair> \
//   SO=target/deploy/onchain_state_solana.so  CONFIRM=yes  npx ts-node scripts/make_buffer.ts
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = (p: string) => p.replace(/^~/, os.homedir());
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
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(home(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json"), "utf8"))));
  const so = fs.readFileSync(process.env.SO ?? "target/deploy/onchain_state_solana.so");
  const size = 37 + so.length;
  const rent = await conn.getMinimumBalanceForRentExemption(size);
  const bal = await conn.getBalance(payer.publicKey);
  const keyFile = home(process.env.BUFFER_KEYPAIR);
  const haveKey = fs.existsSync(keyFile);
  const buffer = haveKey ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyFile, "utf8")))) : Keypair.generate();
  console.log(`program file ${so.length} bytes -> buffer account ${size} bytes, rent ${(rent / 1e9).toFixed(4)} SOL (refunded when the program is deployed/upgraded); payer ${payer.publicKey.toBase58()} has ${(bal / 1e9).toFixed(4)} SOL`);

  // an existing key file whose buffer is already on chain: nothing to do
  const onchain = haveKey ? await conn.getAccountInfo(buffer.publicKey, "confirmed") : null;
  if (onchain) {
    const ok = onchain.owner.equals(LOADER) && onchain.data.length === size && onchain.data.readUInt32LE(0) === 1 && onchain.data[4] === 1 && new PublicKey(onchain.data.subarray(5, 37)).equals(payer.publicKey);
    if (!ok) throw new Error(`the account at ${buffer.publicKey.toBase58()} (from ${keyFile}) is not an empty/filled buffer of this wallet for this program size - refusing to touch it`);
    console.log(`buffer ${buffer.publicKey.toBase58()} already exists on chain (authority = payer, size ok) - nothing to do`);
    return;
  }
  if (bal < rent + 20_000_000) throw new Error("not enough SOL for the buffer rent");
  if (process.env.CONFIRM !== "yes") { console.log(`DRY RUN — ${haveKey ? "the buffer key file exists but the buffer is not on chain" : "a new buffer would be created"}; run again with CONFIRM=yes`); return; }

  // save the key FIRST: whatever happens to the transaction, the buffer address can never be lost
  if (!haveKey) fs.writeFileSync(keyFile, JSON.stringify(Array.from(buffer.secretKey)), { mode: 0o600, flag: "wx" });
  console.log("buffer key saved to", keyFile, "->", buffer.publicKey.toBase58());
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: buffer.publicKey, lamports: rent, space: size, programId: LOADER }),
    new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: buffer.publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([0, 0, 0, 0]) }) // InitializeBuffer (authority = payer)
  );
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, buffer);
  const sig = await conn.sendRawTransaction(tx.serialize());
  // confirm by polling over HTTP (websocket subscriptions get rate-limited on public RPCs)
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("buffer creation failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      if (await conn.getAccountInfo(buffer.publicKey, "confirmed")) break; // it landed after all
      throw new Error(`the transaction did not land (block height exceeded). Nothing was created; run the same command again (the key file ${keyFile} is reused). tx ${sig}`);
    }
    await sleep(700);
  }
  console.log("buffer created:", buffer.publicKey.toBase58(), "tx", sig, "\nkeypair saved to", keyFile);
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
