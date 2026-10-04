// ONE-COMMAND deployment of the new program from the deployer wallet:
//   checks -> buffer (its SOL comes back) -> upload the program bytes with parallel workers (resumable) -> byte-for-byte check -> deploy -> check the program on chain.
// Safe to run again after ANY interruption (closed terminal, RPC errors, power cut): finished steps are recognised and skipped.
// Without CONFIRM=yes it only checks everything and prints the plan (nothing is sent).
//
//   CONFIRM=yes npx ts-node scripts/deploy_mainnet.ts
// Optional: RPC_URL (default: the public mainnet RPC)   DEPLOYER_KEYPAIR (default ~/deployer-mainnet.json)   WORKERS (default 3; use 2 if the RPC throttles hard)
//           DEPLOY_BUFFER_FILE (default ~/mainnet-buffer-NEW.json)
// On purpose it does NOT read ANCHOR_WALLET / ANCHOR_PROVIDER_URL / BUFFER_KEYPAIR / SO / PROGRAM_KEYPAIR from the shell: an old export from earlier sessions
// (for example the previous wallet) must never decide who deploys or on which network. The build, the program key and the expected hash are fixed below.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";

const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const home = (p: string) => p.replace(/^~/, os.homedir());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mask = (s: string) => s.replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***");
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const sol = (l: number | bigint) => (Number(l) / 1e9).toFixed(4);
const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const WALLET = home(process.env.DEPLOYER_KEYPAIR ?? "~/deployer-mainnet.json");
const BUFFER = home(process.env.DEPLOY_BUFFER_FILE ?? "~/mainnet-buffer-NEW.json");
const PROGRAM_KEY = "target/deploy/onchain_state_solana-keypair.json";
const SO = "target/deploy/onchain_state_solana.so";
const EXPECTED_SHA = "eae9b9ea"; // the verified build (sha256 prefix)
const WANT_PROGRAM = "3cbHzoeGBV3gbGZk8GnXyRWkVQzwGhAAUPLdbN1dUfZD";
const WORKERS = Number(process.env.WORKERS ?? 3);
const CHUNK = 900; // the same as in upgrade_program.ts
const FEES = 20_000_000; // 0.02 SOL kept for ~600 transaction fees

async function retryFetch(input: any, init?: any): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, { ...(init || {}), signal: AbortSignal.timeout(30000) });
      if ((r.status === 429 || r.status >= 500) && i < 20) { await sleep(1000 * Math.min(i + 1, 8)); continue; }
      return r;
    } catch (e) { if (i >= 20) throw e; await sleep(1000 * Math.min(i + 1, 8)); }
  }
}

/** Runs one of our scripts as a child process; every output line goes to onLine (default: printed indented). Resolves with the exit code. */
function run(script: string, extraEnv: Record<string, string>, onLine?: (l: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ANCHOR_PROVIDER_URL: RPC, ANCHOR_WALLET: WALLET, BUFFER_KEYPAIR: BUFFER, PROGRAM_KEYPAIR: PROGRAM_KEY, PROGRAM_ID: WANT_PROGRAM, SO, CONFIRM: "yes", ...extraEnv };
    if (!("WORKER" in extraEnv)) delete env.WORKER;
    const child = spawn("npx", ["ts-node", script], { env: env as any, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    const feed = (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1); if (l) (onLine ?? ((x: string) => console.log("   " + mask(x))))(l); }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Reads the program from the chain and compares it with the build. Returns true when everything is right. */
async function verifyDeployed(conn: Connection, so: Buffer, program: PublicKey, programData: PublicKey, payer: PublicKey): Promise<boolean> {
  const prog = await conn.getAccountInfo(program, "confirmed");
  const pd = await conn.getAccountInfo(programData, "confirmed");
  if (!prog || !pd) return false;
  const points = prog.owner.equals(LOADER) && prog.executable && prog.data.readUInt32LE(0) === 2 && new PublicKey(prog.data.subarray(4, 36)).equals(programData);
  const auth = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  const bytes = pd.data.subarray(45, 45 + so.length);
  const same = Buffer.compare(Buffer.from(bytes), so) === 0;
  const authOk = !!auth && auth.equals(payer);
  log(`on-chain program : executable ${prog.executable}, points to its data ${points}, upgrade authority ${auth ? auth.toBase58() : "NONE"} ${authOk ? "(= deployer wallet)" : "(!! NOT the deployer wallet)"}`);
  log(`                   bytes identical to the build: ${same}  sha256 ${sha256(bytes).slice(0, 16)}…  deposit ${sol(pd.lamports)} SOL`);
  return points && same && authOk;
}

async function main() {
  const conn = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch as any });
  const payer = load(WALLET);
  const programKp = load(PROGRAM_KEY);
  const so = fs.readFileSync(SO);
  const sha = sha256(so);
  const [programData] = PublicKey.findProgramAddressSync([programKp.publicKey.toBuffer()], LOADER);
  log(`rpc              : ${mask(RPC)}`);
  log(`deployer wallet  : ${payer.publicKey.toBase58()}  (becomes the upgrade authority)`);
  log(`program address  : ${programKp.publicKey.toBase58()}`);
  log(`build            : ${SO}  ${so.length} bytes  sha256 ${sha.slice(0, 16)}…`);
  if (programKp.publicKey.toBase58() !== WANT_PROGRAM) throw new Error(`the program key file gives ${programKp.publicKey.toBase58()}, expected ${WANT_PROGRAM}`);
  if (!sha.startsWith(EXPECTED_SHA)) throw new Error(`this build (${sha.slice(0, 16)}…) is not the verified one (${EXPECTED_SHA}…) - refusing to deploy an unknown binary`);

  // 0. already deployed?
  if (await conn.getAccountInfo(programData, "confirmed")) {
    log("the program is already deployed here - checking it:");
    const ok = await verifyDeployed(conn, so, programKp.publicKey, programData, payer.publicKey);
    console.log(ok ? "\nALREADY DEPLOYED AND VERIFIED - nothing to do." : "\n!! A program exists at this address but it does not match (see above). Nothing was changed.");
    if (!ok) process.exitCode = 1;
    return;
  }
  if (await conn.getAccountInfo(programKp.publicKey, "confirmed")) throw new Error("an account exists at the program address but its program data is gone: this address was closed and is dead for ever");

  // 1. money check
  const bufRent = await conn.getMinimumBalanceForRentExemption(37 + so.length);
  const dataRent = await conn.getMinimumBalanceForRentExemption(45 + so.length);
  const progRent = await conn.getMinimumBalanceForRentExemption(36);
  const bal = await conn.getBalance(payer.publicKey, "confirmed");
  const bufKp = fs.existsSync(BUFFER) ? load(BUFFER) : null;
  const bufInfo = bufKp ? await conn.getAccountInfo(bufKp.publicKey, "confirmed") : null;
  const need = bufInfo ? dataRent + progRent + FEES - bufInfo.lamports : Math.max(bufRent + FEES, dataRent + progRent + FEES);
  log(`cost             : deposit ${sol(dataRent + progRent)} SOL stays locked while the program exists; the temporary buffer (${sol(bufRent)} SOL) comes back; fees ~0.003 SOL`);
  log(`wallet balance   : ${sol(bal)} SOL, needed ${sol(need)} SOL${bufInfo ? " (the buffer already exists: " + bufKp!.publicKey.toBase58() + ", " + sol(bufInfo.lamports) + " SOL)" : ""}`);
  if (bal < need) throw new Error("not enough SOL on the deployer wallet");
  if (process.env.CONFIRM !== "yes") { console.log("\nDRY RUN — everything is checked, nothing was sent. Run again with CONFIRM=yes in front to deploy."); return; }

  // 2. the buffer (idempotent: an existing key file is reused)
  log("step 1/4: the buffer");
  if ((await run("scripts/make_buffer.ts", {})) !== 0) throw new Error("make_buffer failed - read the lines above");
  const buffer = load(BUFFER);

  // 3. the upload: parallel workers, only missing chunks are written; repeat until the buffer is identical
  const identical = async () => {
    const a = await conn.getAccountInfo(buffer.publicKey, "confirmed");
    return !!a && Buffer.compare(Buffer.from(a.data.subarray(37, 37 + so.length)), so) === 0;
  };
  log(`step 2/4: uploading ${Math.ceil(so.length / CHUNK)} chunks with ${WORKERS} parallel workers (on a public RPC this takes 10-30 minutes; you can stop and run again, it continues where it stopped)`);
  for (let round = 1; round <= 8 && !(await identical()); round++) {
    let done = 0;
    const t0 = Date.now();
    log(`upload round ${round}`);
    await Promise.all(Array.from({ length: WORKERS }, (_, k) => run("scripts/upgrade_program.ts", { WORKER: `${k}/${WORKERS}` }, (l) => {
      if (/rewrote chunk/.test(l)) { done++; if (done % 20 === 0) log(`   ${done} chunks written this round (${Math.round((Date.now() - t0) / 1000)} s)`); }
      else if (/error|fail|exceed/i.test(l)) console.log(`   [worker ${k}] ${mask(l)}`);
    })));
    log(`round ${round} finished: ${done} chunks written`);
  }
  if (!(await identical())) throw new Error("the buffer is still not complete after 8 rounds - run the same command again");
  log("step 3/4: the buffer is byte-for-byte identical to the build");

  // 4. the deploy
  log("step 4/4: deploying (the deposit gets locked, the buffer's SOL comes back)");
  if ((await run("scripts/deploy_new_program.ts", {})) !== 0) throw new Error("deploy failed - read the lines above; after the cause is clear run the same command again");
  let ok = false;
  for (let i = 0; i < 5 && !ok; i++) { ok = await verifyDeployed(conn, so, programKp.publicKey, programData, payer.publicKey); if (!ok) await sleep(3000); }
  log(`wallet balance now: ${sol(await conn.getBalance(payer.publicKey, "confirmed"))} SOL`);
  console.log(ok ? `\nDEPLOYED AND VERIFIED. Program ${programKp.publicKey.toBase58()} is live; its bytes equal the tested build.` : "\n!! the deploy went through but the check on chain failed (see above) - do not use the program, tell the assistant");
  if (!ok) process.exitCode = 1;
}
main().catch((e) => { console.error(mask(String(e?.message ?? e))); process.exit(1); });
