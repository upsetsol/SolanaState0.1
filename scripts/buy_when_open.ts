// BUYS the coin of the "Test 2" launch the moment trading opens: it waits for the opening time of the state's pool, then sends the buy at once and retries
// every fraction of a second until it goes through (price moved by earlier buyers -> it re-quotes). A small priority fee (a few hundredths of a cent) helps to get into the first block.
// Needs no GOVERNANCE_MINT in the shell: the coin is read from the key file the launch saved.
//
//   AMOUNT=<SOL to spend, the 5% pool fee is inside it>   CONFIRM=yes (without it: plan only)
// Optional: BUYER_KEYPAIR (default ~/deployer-mainnet.json)  RPC_URL (default public mainnet)  MINT_FILE (default ~/test2-mint-mainnet.json) or COIN=<mint address>
//           SLIPPAGE=25 (percent: how much worse than the opening price you still accept)   PRIORITY=1000000 (micro-lamports per compute unit; x 400 000 units = at most 0.0004 SOL)
// On purpose it does NOT read ANCHOR_WALLET / ANCHOR_PROVIDER_URL / GOVERNANCE_MINT from the shell (old exports must never decide which wallet buys what).
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { CpAmm, deriveCustomizablePoolAddress } from "@meteora-ag/cp-amm-sdk";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const home = (p: string) => p.replace(/^~/, os.homedir());
const mask = (s: string) => s.replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***");
const load = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 23), ...a);
async function retryFetch(input: any, init?: any): Promise<any> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, { ...(init || {}), signal: AbortSignal.timeout(20000) });
      if ((r.status === 429 || r.status >= 500) && i < 20) { await sleep(500 * Math.min(i + 1, 8)); continue; }
      return r;
    } catch (e) { if (i >= 20) throw e; await sleep(500 * Math.min(i + 1, 8)); }
  }
}

async function main() {
  const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch as any });
  const buyer = load(home(process.env.BUYER_KEYPAIR ?? "~/deployer-mainnet.json"));
  const coin = process.env.COIN ? new PublicKey(process.env.COIN) : load(home(process.env.MINT_FILE ?? "~/test2-mint-mainnet.json")).publicKey;
  if (!/^\d+(\.\d{1,9})?$/.test(process.env.AMOUNT ?? "")) throw new Error("set AMOUNT=<SOL to spend>, for example AMOUNT=0.7");
  const [w, f = ""] = process.env.AMOUNT!.split(".");
  const amountIn = new BN((BigInt(w) * 1_000_000_000n + BigInt(f.padEnd(9, "0"))).toString());
  const slippage = Number(process.env.SLIPPAGE ?? "25"); // percent for the user; the SDK's getQuote takes BASIS POINTS (x100)
  const priority = Number(process.env.PRIORITY ?? "1000000");
  const clock = async () => Number((await conn.getAccountInfo(CLOCK, "confirmed"))!.data.readBigInt64LE(32));

  const cp = new CpAmm(conn);
  const pool = deriveCustomizablePoolAddress(coin, NATIVE_MINT);
  if (!(await cp.isPoolExist(pool))) throw new Error("there is no pool for this coin yet: " + pool.toBase58());
  const state0: any = await cp.fetchPoolState(pool);
  const open = Number(state0.activationPoint.toString());
  const gov = await getMint(conn, coin, "confirmed", TOKEN_2022_PROGRAM_ID);
  const bal = await conn.getBalance(buyer.publicKey, "confirmed");
  const now0 = await clock();
  log(`network ${mask(RPC)}`);
  log(`coin ${coin.toBase58()} | pool ${pool.toBase58()}`);
  log(`buyer ${buyer.publicKey.toBase58()} has ${(bal / 1e9).toFixed(4)} SOL; will spend ${process.env.AMOUNT} SOL (fee 5% inside), slippage ${slippage}%, priority fee at most ${((400000 * priority) / 1e15).toFixed(5)} SOL`);
  log(`trading opens at ${new Date(open * 1000).toString()} (in ${open - now0} s by the chain clock)`);
  if (bal < Number(amountIn.toString()) + 15_000_000) throw new Error("not enough SOL: the amount plus ~0.015 SOL for fees and the token account");
  if (process.env.CONFIRM !== "yes") { console.log("\nDRY RUN — nothing was sent. Run the same command again with CONFIRM=yes in front, a few minutes BEFORE the opening time; it waits and buys by itself."); return; }

  // wait for the opening (the chain clock runs a few seconds behind the wall clock)
  let now = now0, lastPrint = 0;
  while (now < open - 4) {
    if (Date.now() - lastPrint > 30000) { log(`waiting for the opening: ${open - now} s left`); lastPrint = Date.now(); }
    await sleep(Math.min(5000, Math.max(500, (open - 4 - now) * 1000)));
    now = await clock();
  }
  log("about to open - preparing the buy");

  const build = async (state: any, quoteTime: number, blockhash: string) => {
    const slot = await conn.getSlot();
    const q: any = cp.getQuote({ inAmount: amountIn, inputTokenMint: NATIVE_MINT, slippage: Math.round(slippage * 100), poolState: state, currentTime: quoteTime, currentSlot: slot, tokenADecimal: gov.decimals, tokenBDecimal: 9 } as any);
    const tx: Transaction = await cp.swap({
      payer: buyer.publicKey, pool, inputTokenMint: NATIVE_MINT, outputTokenMint: coin, amountIn, minimumAmountOut: q.minSwapOutAmount ?? new BN(0),
      tokenAMint: coin, tokenBMint: NATIVE_MINT, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, poolState: state,
    } as any);
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }));
    tx.feePayer = buyer.publicKey;
    tx.recentBlockhash = blockhash;
    tx.sign(buyer);
    return { raw: tx.serialize(), quoted: q.swapOutAmount?.toString?.() ?? "?" };
  };

  // the price at the opening is known (nobody has traded yet): quote it as if it were open already, build and sign the transaction BEFORE the opening
  let { blockhash } = await conn.getLatestBlockhash("confirmed");
  let bhAt = Date.now();
  let prepared = await build(state0, open, blockhash);
  log(`buy prepared: ${process.env.AMOUNT} SOL -> about ${(Number(prepared.quoted) / 10 ** gov.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })} coins at the opening price`);
  while (now < open - 1) { await sleep(300); now = await clock(); if (Date.now() - bhAt > 25000) { ({ blockhash } = await conn.getLatestBlockhash("confirmed")); bhAt = Date.now(); prepared = await build(state0, open, blockhash); } }

  const sent: string[] = [];
  const holdings = async () => {
    const ata = getAssociatedTokenAddressSync(coin, buyer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    return (await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  };
  const report = async (sig: string) => {
    const have = await holdings();
    console.log(`\nBOUGHT. tx ${sig}\nyou now hold ${(Number(have) / 10 ** gov.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })} coins = ${(Number((have * 10000n) / BigInt(gov.supply.toString())) / 100).toFixed(2)}% of the supply`);
  };
  // did one of the transactions we already sent land? (a retry must never buy twice)
  const landed = async (): Promise<string | null> => {
    if (!sent.length) return null;
    const st = (await conn.getSignatureStatuses(sent, { searchTransactionHistory: true })).value;
    for (let i = 0; i < sent.length; i++) if (st[i] && !st[i]!.err && (st[i]!.confirmationStatus === "confirmed" || st[i]!.confirmationStatus === "finalized")) return sent[i];
    return null;
  };

  let rebuilds = 0;
  for (let attempt = 1; attempt <= 400; attempt++) {
    try {
      if (Date.now() - bhAt > 40000) { ({ blockhash } = await conn.getLatestBlockhash("confirmed")); bhAt = Date.now(); prepared = await build((await cp.fetchPoolState(pool)) as any, await clock(), blockhash); }
      const sig = await conn.sendRawTransaction(prepared.raw, { skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 });
      if (!sent.includes(sig)) sent.push(sig);
      log(`sent (attempt ${attempt}) tx ${sig}`);
      for (let i = 0; i < 150; i++) {
        const st = (await conn.getSignatureStatuses([sig])).value[0];
        if (st?.err) throw Object.assign(new Error("the transaction failed on chain: " + JSON.stringify(st.err)), { onchainCode: (st.err as any)?.InstructionError?.[1]?.Custom }); // a failed transaction did nothing: safe to retry
        if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { await report(sig); return; }
        await sleep(400);
      }
      throw new Error("not confirmed in 60 s - check the wallet before running again");
    } catch (e: any) {
      const msg = String(e?.message ?? e) + " " + (Array.isArray(e?.logs) ? e.logs.join(" ") : "") + " " + (Array.isArray(e?.transactionLogs) ? e.transactionLogs.join(" ") : "");
      const done = await landed().catch(() => null);
      if (done) { await report(done); return; }
      if (/not confirmed in 60 s/.test(msg)) throw e;                            // status unknown: do not risk a double buy, look first
      if (/insufficient lamports|insufficient funds|Insufficient/i.test(msg)) throw e;
      if (e?.onchainCode === 6003) { await sleep(250); continue; }               // Meteora "PoolDisabled": not open yet by the leader's clock
      if (/failed on chain/.test(msg) && e?.onchainCode !== 6002) throw e;       // any other on-chain failure is a real problem
      if ((/slippage|ExceededSlippage/i.test(msg) || e?.onchainCode === 6002) && rebuilds < 12) { // the price moved (others bought first): re-quote and rebuild
        rebuilds++;
        ({ blockhash } = await conn.getLatestBlockhash("confirmed")); bhAt = Date.now();
        prepared = await build((await cp.fetchPoolState(pool)) as any, await clock(), blockhash);
        log(`price moved, re-quoted: about ${(Number(prepared.quoted) / 10 ** gov.decimals).toLocaleString("en-US", { maximumFractionDigits: 0 })} coins`);
        continue;
      }
      if (attempt % 10 === 1) log(`not through yet (${msg.trim().slice(0, 110)}) - retrying`);
      await sleep(250);
    }
  }
  throw new Error("could not buy after 400 attempts - check the pool and the wallet");
}
main().catch((e) => { console.error(mask(String(e?.message ?? e))); process.exit(1); });
