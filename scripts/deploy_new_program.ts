// FIRST deployment of a program from a filled and verified upgrade buffer (the buffer is made by scripts/make_buffer.ts and filled by
// scripts/upgrade_program.ts WITHOUT --upgrade). Works without the Rust CLI. The program keypair signs once, to claim its address.
//
//   ANCHOR_PROVIDER_URL=<rpc>  ANCHOR_WALLET=<payer = future upgrade authority>
//   PROGRAM_KEYPAIR=target/deploy/onchain_state_solana-keypair.json     (the new program's address key)
//   BUFFER_KEYPAIR=<buffer keypair json>   SO=target/deploy/onchain_state_solana.so
//   MAX_DATA_LEN=<bytes>      (optional, default = size of the .so; the program can later grow only up to this size without paying for an extension)
//   CONFIRM=yes               without it the script only prints the plan
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p.replace("~", os.homedir()), "utf8"))));
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
  const payer = load(process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json");
  const program = load(process.env.PROGRAM_KEYPAIR ?? "target/deploy/onchain_state_solana-keypair.json");
  const buffer = load(process.env.BUFFER_KEYPAIR);
  const so = fs.readFileSync(process.env.SO ?? "target/deploy/onchain_state_solana.so");
  const maxLen = BigInt(process.env.MAX_DATA_LEN ?? so.length);
  if (maxLen < BigInt(so.length)) throw new Error("MAX_DATA_LEN is smaller than the program");
  const [programData] = PublicKey.findProgramAddressSync([program.publicKey.toBuffer()], LOADER);

  if (await conn.getAccountInfo(program.publicKey)) throw new Error("an account already exists at the program address " + program.publicKey.toBase58());
  const buf = await conn.getAccountInfo(buffer.publicKey, "confirmed");
  if (!buf) throw new Error("buffer account not found");
  const same = Buffer.compare(Buffer.from(buf.data.subarray(37, 37 + so.length)), so) === 0;
  const authority = new PublicKey(buf.data.subarray(5, 37));
  const programRent = await conn.getMinimumBalanceForRentExemption(36);
  const dataRent = await conn.getMinimumBalanceForRentExemption(45 + Number(maxLen));
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`program address : ${program.publicKey.toBase58()}`);
  console.log(`buffer          : ${buffer.publicKey.toBase58()}  byte-identical to the .so: ${same}  authority ${authority.toBase58() === payer.publicKey.toBase58() ? "= payer" : "!= PAYER (" + authority.toBase58() + ")"}`);
  console.log(`size            : ${so.length} bytes, room reserved ${maxLen}`);
  console.log(`deposit         : ${((programRent + dataRent) / 1e9).toFixed(4)} SOL stays locked while the program exists (the buffer's ${(buf.lamports / 1e9).toFixed(4)} SOL comes back to the payer first)`);
  console.log(`payer           : ${payer.publicKey.toBase58()} has ${(bal / 1e9).toFixed(4)} SOL (the upgrade authority will be this wallet)`);
  if (!same) throw new Error("the buffer does not match the .so - finish scripts/upgrade_program.ts first (without --upgrade)");
  if (authority.toBase58() !== payer.publicKey.toBase58()) throw new Error("the buffer authority is not the payer");
  if (bal + buf.lamports < programRent + dataRent + 10_000_000) throw new Error("not enough SOL: need the deposit above plus ~0.01 for fees");
  if (process.env.CONFIRM !== "yes") { console.log("\nDRY RUN — nothing was sent. Run again with CONFIRM=yes."); return; }

  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // DeployWithMaxDataLen
  data.writeBigUInt64LE(maxLen, 4);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: program.publicKey, lamports: programRent, space: 36, programId: LOADER }),
    new TransactionInstruction({
      programId: LOADER,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: programData, isSigner: false, isWritable: true },
        { pubkey: program.publicKey, isSigner: false, isWritable: true },
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    })
  );
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, program);
  const sig = await conn.sendRawTransaction(tx.serialize());
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("deploy failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("block height exceeded - check the explorer before running again: " + sig);
    await sleep(700);
  }
  console.log("\nDEPLOYED. tx", sig);
  console.log("program", program.publicKey.toBase58(), "| program data", programData.toBase58(), "| payer balance now", (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
