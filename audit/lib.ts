// Shared harness for the abuse / security tests in audit/.  LOCAL VALIDATOR ONLY.
//
// It builds a throw-away "world" (fresh governance mint, a state initialised on the real program binary,
// holders, optionally a real Meteora DAMM v2 pool) and gives every scenario the same helpers, so each attack
// runs against the actual bytecode (target/deploy/onchain_state_solana.so = the v4.1 build).  Nothing here changes
// the contract.  The FIRST run of these tests (2026-09-30, v4 = the binary that is on mainnet "Test 1",
// sha256 5e138c88…7237) is kept in audit/results_v4/.
//
// Verdicts:
//   BLOCKED      the attack was rejected by the contract  (good)
//   EXPLOITABLE  the attack worked                        (a finding)
//   OK           a positive control / the legit path worked
//   INFO         a measurement
//   ERROR        the harness itself failed - must be looked at by a human
// Status = what was decided about a finding (Roman / Nikita, 2026-09-30):
//   FIXED     it worked against v4 and the v4.1 change stops it (verdict BLOCKED)
//   ACCEPTED  it still works and the owner decided to leave it as it is
//   PENDING   it still works and the decision is not taken yet (launch procedure / Nikita)
// An EXPLOITABLE row WITHOUT a status is unexpected (a regression or an undecided finding) and is listed separately.

import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, TYPE_SIZE, LENGTH_SIZE,
  AuthorityType, getMintLen, createInitializeMintInstruction, createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferCheckedInstruction,
  createSyncNativeInstruction, createSetAuthorityInstruction, getAssociatedTokenAddressSync, getAccount, getMint,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadataIx, pack } from "@solana/spl-token-metadata";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress, derivePositionAddress, derivePositionNftAccount,
} from "@meteora-ag/cp-amm-sdk";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";

export const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error("audit tests run against a LOCAL validator only (got " + RPC + ")");

export const IDL = JSON.parse(fs.readFileSync("./idl/onchain_state_solana.json", "utf8"));
export const PROGRAM_ID = new PublicKey(IDL.address);
export const TP = TOKEN_2022_PROGRAM_ID; // governance coin
export const TPT = TOKEN_PROGRAM_ID; // treasury asset (wSOL)
export const ATAP = ASSOCIATED_TOKEN_PROGRAM_ID;
export const DEC = 9;
export const METEORA = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const COIN = 10n ** BigInt(DEC); // one whole coin in base units
export const SOL = BigInt(LAMPORTS_PER_SOL);
export { BN, anchor, NATIVE_MINT };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- results
export type Verdict = "BLOCKED" | "EXPLOITABLE" | "OK" | "INFO" | "ERROR";
export type Status = "FIXED" | "ACCEPTED" | "PENDING" | "";
export interface Row { group: string; id: string; title: string; verdict: Verdict; note?: string; status?: Status }
export const rows: Row[] = [];
let curGroup = "";
export function group(name: string) { curGroup = name; console.log(`\n=== ${name} ===`); }
const ICON: Record<Verdict, string> = { BLOCKED: "🛡️ BLOCKED    ", EXPLOITABLE: "⚠️ EXPLOITABLE", OK: "✅ OK         ", INFO: "ℹ️ INFO       ", ERROR: "❌ ERROR      " };
export function record(id: string, title: string, verdict: Verdict, note?: string, status: Status = "") {
  rows.push({ group: curGroup, id, title, verdict, note, status });
  console.log(`${ICON[verdict]} [${id}] ${title}${note ? "  — " + note : ""}${status ? "  {" + status + "}" : ""}`);
}
export function errText(e: any): string {
  const parts = [e?.error?.errorCode?.code, e?.error?.errorMessage, e?.message, ...(e?.logs ?? []), ...(e?.transactionLogs ?? [])];
  return parts.filter(Boolean).join(" | ");
}
/** An attack that a v4.1 change is meant to stop.  worked=false => BLOCKED {FIXED}; worked=true => EXPLOITABLE with NO status (a regression). */
export function recordFixed(id: string, title: string, worked: boolean, note?: string) {
  record(id, title, worked ? "EXPLOITABLE" : "BLOCKED", note, worked ? "" : "FIXED");
}
/** An attack that is known to work and was consciously left (ACCEPTED) or is still undecided (PENDING).  worked=false => BLOCKED (unexpected, no status). */
export function recordKnown(id: string, title: string, worked: boolean, status: "ACCEPTED" | "PENDING", note?: string) {
  record(id, title, worked ? "EXPLOITABLE" : "BLOCKED", note, worked ? status : "");
}
/** Run a call that may fail; never throws. */
export async function attempt(fn: () => Promise<any>): Promise<{ ok: boolean; err: string }> {
  try { await fn(); return { ok: true, err: "" }; } catch (e: any) { return { ok: false, err: errText(e) }; }
}
/** The attack SHOULD fail. Fails with one of `codes` => BLOCKED; succeeds => EXPLOITABLE; other error => ERROR. */
export async function expectBlocked(id: string, title: string, codes: string | string[], fn: () => Promise<any>, exploitNote?: string) {
  const want = Array.isArray(codes) ? codes : [codes];
  try {
    await fn();
    record(id, title, "EXPLOITABLE", exploitNote ?? "the call SUCCEEDED (it should have been rejected)");
  } catch (e: any) {
    const txt = errText(e);
    const code = e?.error?.errorCode?.code;
    const hit = want.some((c) => code === c || txt.includes(c));
    record(id, title, hit ? "BLOCKED" : "ERROR", hit ? `rejected: ${code ?? want.find((c) => txt.includes(c))}` : `rejected with something unexpected: ${txt.slice(0, 260)}`);
  }
}
/** A call that is EXPECTED to work (positive control or step of an attack). Throws on failure. */
export async function must(id: string, title: string, fn: () => Promise<any>, note?: string) {
  try {
    const r = await fn();
    record(id, title, "OK", note);
    return r;
  } catch (e: any) {
    record(id, title, "ERROR", errText(e).slice(0, 300));
    throw e;
  }
}

// ---------------------------------------------------------------- chain plumbing (HTTP polling, no websockets)
const EXPIRED = /expired|block height exceeded|Blockhash not found|blockhash not found/i;
export const conn = new Connection(RPC, { commitment: "confirmed" });
async function confirmPoll(c: Connection, sig: string, lastValidBlockHeight: number) {
  for (;;) {
    const st = (await c.getSignatureStatuses([sig])).value[0];
    if (st) {
      if (st.err) throw new Error("Transaction " + sig + " failed: " + JSON.stringify(st.err));
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    if ((await c.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("block height exceeded");
    await sleep(250);
  }
}
export async function sendTx(c: Connection, tx: Transaction, sign: (t: Transaction) => Promise<Transaction>, opts?: any): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const signed = await sign(tx);
      const sig = await c.sendRawTransaction(signed.serialize(), { skipPreflight: opts?.skipPreflight ?? false, preflightCommitment: "confirmed" });
      await confirmPoll(c, sig, lastValidBlockHeight);
      return sig;
    } catch (e: any) {
      if (i < 4 && EXPIRED.test(String(e?.message ?? e))) { await sleep(500); continue; }
      throw e;
    }
  }
}
(anchor.AnchorProvider.prototype as any).sendAndConfirm = async function (this: any, tx: any, signers?: Keypair[], opts?: any) {
  if (!(tx instanceof Transaction)) throw new Error("only legacy transactions are used in this suite");
  tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
  return sendTx(this.connection, tx, async (t) => {
    t.signatures = [];
    (signers ?? []).forEach((k) => t.partialSign(k));
    return this.wallet.signTransaction(t);
  }, opts ?? this.opts);
};
export async function sendSigned(tx: Transaction, signers: Keypair[]) {
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  return sendTx(conn, tx, async (t) => { t.signatures = []; t.sign(...signers); return t; });
}
export async function chainNow() {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return Number(info!.data.readBigInt64LE(32));
}
export async function waitChain(target: number) {
  for (;;) {
    const n = await chainNow();
    if (n >= target) return;
    await sleep(Math.min((target - n) * 1000, 1500));
  }
}
export function u64(n: any) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n.toString()));
  return b;
}
export async function airdrop(to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, Math.round(sol * LAMPORTS_PER_SOL));
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    await sleep(200);
  }
}
export async function newFunded(sol = 5): Promise<Keypair> {
  const kp = Keypair.generate();
  await airdrop(kp.publicKey, sol);
  return kp;
}
export const progFor = (kp: Keypair) =>
  new anchor.Program(IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })) as any;

// ---------------------------------------------------------------- generic mint helpers
export async function createGovMint(payer: Keypair, opts: { supplyCoins?: bigint; mintAuthority?: PublicKey | null; extra?: (mint: PublicKey) => any[]; extraExt?: ExtensionType[] } = {}) {
  const mint = Keypair.generate();
  const meta = { mint: mint.publicKey, name: "Audit", symbol: "AUD", uri: "", additionalMetadata: [] as [string, string][] };
  const exts = [ExtensionType.MetadataPointer, ...(opts.extraExt ?? [])];
  const mintLen = getMintLen(exts);
  const rent = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(meta).length);
  const me = payer.publicKey;
  const myAta = getAssociatedTokenAddressSync(mint.publicKey, me, false, TP, ATAP);
  const supply = (opts.supplyCoins ?? 1_000_000_000n) * COIN;
  await sendSigned(
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: mint.publicKey, space: mintLen, lamports: rent, programId: TP }),
      createInitializeMetadataPointerInstruction(mint.publicKey, me, mint.publicKey, TP),
      ...(opts.extra ? opts.extra(mint.publicKey) : []),
      createInitializeMintInstruction(mint.publicKey, DEC, me, null, TP),
      createInitMetadataIx({ programId: TP, metadata: mint.publicKey, updateAuthority: me, mint: mint.publicKey, mintAuthority: me, name: meta.name, symbol: meta.symbol, uri: meta.uri }),
      createAssociatedTokenAccountIdempotentInstruction(me, myAta, me, mint.publicKey, TP, ATAP),
      createMintToInstruction(mint.publicKey, myAta, me, supply, [], TP)
    ),
    [payer, mint]
  );
  return { mint, myAta, supply };
}
export const configPdaOf = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("config"), mint.toBuffer()], PROGRAM_ID)[0];

export interface Params {
  vote: number; timelock: number; cooldown: number; fallback: number; grace: number;
  thresholdBps: number; quorumSpendBps: number; quorumRoleBps: number; quorumParamBps: number;
  finDaily: number; finWeekly: number; culDaily: number; culWeekly: number;
  payPres: number; payFin: number; payCul: number; citizenBps: number; msDepositBps: number;
}
export const DEFAULT_PARAMS: Params = {
  vote: 12, timelock: 6, cooldown: 8, fallback: 6, grace: 10,
  thresholdBps: 100, quorumSpendBps: 300, quorumRoleBps: 1000, quorumParamBps: 1500,
  finDaily: 50, finWeekly: 150, culDaily: 20, culWeekly: 50, payPres: 10, payFin: 5, payCul: 5, citizenBps: 25, msDepositBps: 1000,
};
export function initArgs(owners: PublicKey, admin: PublicKey, president: PublicKey, p: Params) {
  const b = (n: number) => new anchor.BN(n);
  return [
    owners, admin, president, b(p.vote), b(p.thresholdBps), b(p.quorumSpendBps), b(p.quorumRoleBps), b(p.quorumParamBps),
    b(p.finDaily), b(p.finWeekly), b(p.culDaily), b(p.culWeekly), b(p.timelock), b(p.payPres), b(p.payFin), b(p.payCul),
    b(p.citizenBps), b(p.msDepositBps), b(p.cooldown), b(p.fallback), b(p.grace),
  ];
}

// ---------------------------------------------------------------- the world
export interface WorldOpts { name: string; params?: Partial<Params>; supplyCoins?: bigint; seedTreasury?: bigint }
export async function makeWorld(o: WorldOpts) {
  const P: Params = { ...DEFAULT_PARAMS, ...(o.params ?? {}) };
  const payer = await newFunded(20000); // deployer = owners_authority = admin = president
  const me = payer.publicKey;
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(IDL, provider) as any;
  const { mint, myAta, supply } = await createGovMint(payer, { supplyCoins: o.supplyCoins });
  const configPda = configPdaOf(mint.publicKey);
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, configPda, true, TPT, ATAP);
  const tAta = (x: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, x, true, TPT, ATAP);
  const ata = (x: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, x, false, TP, ATAP);
  const [milestoneFundPda] = PublicKey.findProgramAddressSync([Buffer.from("milestone_fund"), configPda.toBuffer()], PROGRAM_ID);
  const feeAAccount = getAssociatedTokenAddressSync(mint.publicKey, configPda, true, TP, ATAP);
  const proposalPda = (id: any) => PublicKey.findProgramAddressSync([Buffer.from("proposal"), configPda.toBuffer(), u64(id)], PROGRAM_ID)[0];
  const snapPda = (p: PublicKey, v: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("voter_snapshot"), p.toBuffer(), v.toBuffer()], PROGRAM_ID)[0];
  const trackerPda = (role: number) => PublicKey.findProgramAddressSync([Buffer.from("spend_tracker"), configPda.toBuffer(), Buffer.from([role])], PROGRAM_ID)[0];
  const milestonePda = (n: any) => PublicKey.findProgramAddressSync([Buffer.from("milestone"), configPda.toBuffer(), u64(n)], PROGRAM_ID)[0];
  const mSnapPda = (m: PublicKey, h: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("milestone_snap"), m.toBuffer(), h.toBuffer()], PROGRAM_ID)[0];
  const payrollPda = (role: number) => PublicKey.findProgramAddressSync([Buffer.from("payroll"), configPda.toBuffer(), Buffer.from([role])], PROGRAM_ID)[0];
  const bal = async (a: PublicKey): Promise<bigint> => { try { return (await getAccount(conn, a, "confirmed", TP)).amount; } catch { return -1n; } };
  const tbal = async (a: PublicKey): Promise<bigint> => { try { return (await getAccount(conn, a, "confirmed", TPT)).amount; } catch { return -1n; } };
  const cfg = async () => program.account.config.fetch(configPda);
  /** native lamports + wrapped SOL of a wallet (what the wallet is really worth in SOL terms) */
  const solOf = async (k: PublicKey): Promise<bigint> => {
    const w1 = await tbal(tAta(k));
    return BigInt(await conn.getBalance(k, "confirmed")) + (w1 > 0n ? w1 : 0n);
  };
  const excl = async (): Promise<PublicKey | null> => {
    const k: PublicKey = (await cfg()).quorumExcludedAccount;
    return k.equals(PublicKey.default) ? null : k;
  };
  const supplyNow = async () => (await getMint(conn, mint.publicKey, "confirmed", TP)).supply;

  await program.methods
    .initialize(...initArgs(me, me, me, P))
    .accounts({ owner: me, governanceMint: mint.publicKey, treasuryMint: NATIVE_MINT, config: configPda, treasury, tokenProgram: TPT, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId })
    .rpc();
  await program.methods
    .setupMilestoneFund()
    .accounts({ owner: me, config: configPda, treasuryMint: NATIVE_MINT, milestoneFund: milestoneFundPda, tokenProgram: TPT, systemProgram: SystemProgram.programId })
    .rpc();

  const ensureT = async (x: PublicKey) =>
    sendSigned(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, tAta(x), x, NATIVE_MINT, TPT, ATAP)), [payer]);
  await ensureT(me);

  /** New wallet with SOL, both token accounts, and `coins` whole coins taken from the deployer. */
  async function holder(coins: bigint, sol = 50): Promise<Keypair> {
    const h = Keypair.generate();
    await sendSigned(new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: h.publicKey, lamports: sol * LAMPORTS_PER_SOL })), [payer]);
    const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, ata(h.publicKey), h.publicKey, mint.publicKey, TP, ATAP));
    tx.add(createAssociatedTokenAccountIdempotentInstruction(me, tAta(h.publicKey), h.publicKey, NATIVE_MINT, TPT, ATAP));
    if (coins > 0n) tx.add(createTransferCheckedInstruction(myAta, mint.publicKey, ata(h.publicKey), me, coins * COIN, DEC, [], TP));
    await sendSigned(tx, [payer]);
    return h;
  }
  async function transferCoins(from: Keypair, to: PublicKey, coins: bigint) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(from.publicKey, ata(to), to, mint.publicKey, TP, ATAP),
      createTransferCheckedInstruction(ata(from.publicKey), mint.publicKey, ata(to), from.publicKey, coins * COIN, DEC, [], TP)
    );
    await sendSigned(tx, [from]);
  }
  async function seedTreasury(lamports: bigint) {
    await sendSigned(new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: treasury, lamports: Number(lamports) }), createSyncNativeInstruction(treasury, TPT)), [payer]);
  }
  async function fundMilestoneDirect(lamports: bigint) {
    await sendSigned(new Transaction().add(SystemProgram.transfer({ fromPubkey: me, toPubkey: milestoneFundPda, lamports: Number(lamports) }), createSyncNativeInstruction(milestoneFundPda, TPT)), [payer]);
  }

  // ---- governance helpers
  const createAccts = async (creator: PublicKey, creatorAta: PublicKey, pPda: PublicKey) => ({
    creator, config: configPda, governanceMint: mint.publicKey, creatorTokenAccount: creatorAta, treasury,
    quorumExcluded: await excl(), proposal: pPda, systemProgram: SystemProgram.programId,
  });
  async function propose(type: number, target: PublicKey, amount: any, paramKey: number, reason: string, by: Keypair = payer) {
    const c = await cfg();
    const id = c.proposalCount;
    const pPda = proposalPda(id);
    await progFor(by).methods.createProposal(type, target, new anchor.BN(amount.toString()), paramKey, reason)
      .accounts(await createAccts(by.publicKey, ata(by.publicKey), pPda)).rpc();
    return { id, pPda };
  }
  const snapAccts = (pPda: PublicKey, voter: PublicKey, owner: PublicKey = me, voterTokenAccount?: PublicKey) => ({
    owner, config: configPda, proposal: pPda, voterTokenAccount: voterTokenAccount ?? ata(voter),
    voterSnapshot: snapPda(pPda, voter), systemProgram: SystemProgram.programId,
  });
  /** Post a snapshot. `weight` = what the owner's scan saw; by default the voter's balance RIGHT NOW (an honest, immediate scan). */
  async function snapshot(id: any, pPda: PublicKey, voter: PublicKey, by: Keypair = payer, voterTokenAccount?: PublicKey, weight?: bigint) {
    const wgt = weight ?? (await bal(voterTokenAccount ?? ata(voter)));
    await progFor(by).methods.postVoterSnapshot(new anchor.BN(id.toString()), voter, new anchor.BN(wgt.toString())).accounts(snapAccts(pPda, voter, by.publicKey, voterTokenAccount)).rpc();
  }
  /** The owner closes the enrolment: votes are accepted from now on and the quorum base is frozen. */
  async function openVoting(id: any, opts: { excludedOverride?: PublicKey | null } = {}, by: Keypair = payer) {
    await progFor(by).methods.openVoting(new anchor.BN(id.toString()))
      .accounts({ owner: by.publicKey, config: configPda, governanceMint: mint.publicKey, proposal: proposalPda(id), quorumExcluded: opts.excludedOverride !== undefined ? opts.excludedOverride : await excl() }).rpc();
  }
  async function vote(kp: Keypair, id: any, pPda: PublicKey, support: boolean, snapshotOf?: PublicKey) {
    await progFor(kp).methods.vote(new anchor.BN(id.toString()), support)
      .accounts({ voter: kp.publicKey, config: configPda, proposal: pPda, voterSnapshot: snapPda(pPda, snapshotOf ?? kp.publicKey) }).rpc();
  }
  async function execute(id: any, opts: { recipient?: PublicKey; milestoneFund?: boolean } = {}, who: Keypair = payer) {
    await progFor(who).methods.executeProposal(new anchor.BN(id.toString()))
      .accounts({
        executor: who.publicKey, config: configPda, treasuryMint: NATIVE_MINT, proposal: proposalPda(id), treasury,
        recipientTokenAccount: opts.recipient ?? null, milestoneFund: opts.milestoneFund ? milestoneFundPda : null, tokenProgram: TPT,
      }).rpc();
  }
  const proposalOf = async (pPda: PublicKey) => program.account.proposal.fetch(pPda);
  const deadlineOf = async (pPda: PublicKey) => Number((await proposalOf(pPda)).deadline.toString());
  const waitExecutable = async (pPda: PublicKey) => waitChain((await deadlineOf(pPda)) + P.timelock + 2);

  // ---- milestone helpers
  async function createMilestone() {
    const n = (await cfg()).nextMilestoneNumber;
    const m = milestonePda(n);
    await program.methods.createMilestone().accounts({ owner: me, config: configPda, milestoneRecord: m, systemProgram: SystemProgram.programId }).rpc();
    return { n, m };
  }
  async function msSnap(n: any, m: PublicKey, h: PublicKey, holderTokenAccount?: PublicKey, weight?: bigint) {
    const wgt = weight ?? (await bal(holderTokenAccount ?? ata(h)));
    await program.methods.postMilestoneSnapshot(new anchor.BN(n.toString()), h, new anchor.BN(wgt.toString()))
      .accounts({ owner: me, config: configPda, governanceMint: mint.publicKey, milestoneRecord: m, holderTokenAccount: holderTokenAccount ?? ata(h), milestoneSnapshot: mSnapPda(m, h), systemProgram: SystemProgram.programId }).rpc();
  }
  async function msFinalize(n: any, m: PublicKey, prev: PublicKey | null = null) {
    await program.methods.finalizeMilestone(new anchor.BN(n.toString()))
      .accounts({ owner: me, config: configPda, milestoneRecord: m, previousMilestone: prev, milestoneFund: milestoneFundPda, governanceMint: mint.publicKey }).rpc();
  }
  const claimAccts = (m: PublicKey, h: PublicKey, payerKey: PublicKey = me, dest?: PublicKey) => ({
    payer: payerKey, config: configPda, treasuryMint: NATIVE_MINT, milestoneRecord: m, milestoneSnapshot: mSnapPda(m, h),
    milestoneFund: milestoneFundPda, claimantTokenAccount: dest ?? tAta(h), tokenProgram: TPT,
  });
  async function msClaim(n: any, m: PublicKey, h: PublicKey, by: Keypair = payer, dest?: PublicKey) {
    await progFor(by).methods.claimMilestone(new anchor.BN(n.toString()), h).accounts(claimAccts(m, h, by.publicKey, dest)).rpc();
  }

  // ---- pool
  const cpAmm = new CpAmm(conn);
  const poolAddr = deriveCustomizablePoolAddress(mint.publicKey, NATIVE_MINT);
  let poolInfo: { position: PublicKey; nftAccount: PublicKey; positionNft: Keypair } | null = null;
  async function withPool(poolCoins: bigint, poolLamports: bigint, feeBps = 500, beforeHandover?: (x: { positionNft: Keypair; nftAccount: PublicKey; position: PublicKey }) => Promise<void>) {
    const positionNft = Keypair.generate();
    const tokenAAmount = new BN((poolCoins * COIN).toString());
    const tokenBAmount = new BN(poolLamports.toString());
    const prep = cpAmm.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.OnlyB } as any);
    const poolFees = {
      baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 } }),
      compoundingFeeBps: 0, padding: 0, dynamicFee: null,
    };
    const { tx } = await cpAmm.createCustomPool({
      payer: me, creator: me, positionNft: positionNft.publicKey, tokenAMint: mint.publicKey, tokenBMint: NATIVE_MINT, tokenAAmount, tokenBAmount,
      sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
      poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB, activationPoint: null,
      tokenAProgram: TP, tokenBProgram: TPT, isLockLiquidity: true,
    } as any);
    await provider.sendAndConfirm(tx, [positionNft]);
    const position = derivePositionAddress(positionNft.publicKey);
    const nftAccount = derivePositionNftAccount(positionNft.publicKey);
    if (beforeHandover) await beforeHandover({ positionNft, nftAccount, position });
    await provider.sendAndConfirm(new Transaction().add(createSetAuthorityInstruction(nftAccount, me, AuthorityType.AccountOwner, configPda, [], TP)));
    await program.methods.registerPool().accounts({
      owner: me, config: configPda, governanceMint: mint.publicKey, pool: poolAddr, position, positionNftAccount: nftAccount, feeAAccount,
      governanceTokenProgram: TP, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
    }).rpc();
    poolInfo = { position, nftAccount, positionNft };
    return poolInfo;
  }
  /** side "buy": spend `amountLamports` of SOL, receive coins.  side "sell": sell `amountCoins` whole coins for SOL. */
  async function swap(kp: Keypair, side: "buy" | "sell", amount: bigint, pool: PublicKey = poolAddr) {
    const st: any = await cpAmm.fetchPoolState(pool);
    const inMint = side === "buy" ? NATIVE_MINT : mint.publicKey;
    const outMint = side === "buy" ? mint.publicKey : NATIVE_MINT;
    const amountIn = side === "buy" ? new BN(amount.toString()) : new BN((amount * COIN).toString());
    const tx = await cpAmm.swap({
      payer: kp.publicKey, pool, inputTokenMint: inMint, outputTokenMint: outMint, amountIn, minimumAmountOut: new BN(0),
      tokenAMint: mint.publicKey, tokenBMint: NATIVE_MINT, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
      tokenAProgram: TP, tokenBProgram: TPT, referralTokenAccount: null, poolState: st,
    } as any);
    await sendSigned(tx, [kp]);
  }
  const poolVaultA = async (): Promise<PublicKey> => new PublicKey((await conn.getAccountInfo(poolAddr))!.data.subarray(232, 264));
  const poolVaultB = async (): Promise<PublicKey> => new PublicKey((await conn.getAccountInfo(poolAddr))!.data.subarray(264, 296));
  const claimFeesAccts = async (caller: PublicKey, overrides: any = {}) => {
    const c = await cfg();
    return {
      caller, config: configPda, governanceMint: mint.publicKey, treasuryMint: NATIVE_MINT, treasury, feeAAccount, poolAuthority: POOL_AUTHORITY,
      pool: c.feePool, position: c.feePosition, tokenAVault: await poolVaultA(), tokenBVault: await poolVaultB(), positionNftAccount: c.feePositionNftAccount,
      tokenAProgram: TP, tokenBProgram: TPT, eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], METEORA)[0], meteoraProgram: METEORA,
      ...overrides,
    };
  };

  return {
    name: o.name, P, payer, me, provider, program, mint, myAta, supply, configPda, treasury, milestoneFundPda, feeAAccount, poolAddr,
    tAta, ata, proposalPda, snapPda, trackerPda, milestonePda, mSnapPda, payrollPda, bal, tbal, cfg, excl, supplyNow, solOf,
    holder, transferCoins, seedTreasury, fundMilestoneDirect, ensureT,
    createAccts, propose, snapshot, openVoting, vote, execute, proposalOf, deadlineOf, waitExecutable, snapAccts,
    createMilestone, msSnap, msFinalize, msClaim, claimAccts,
    withPool, swap, poolVaultA, poolVaultB, claimFeesAccts, cpAmm, get poolInfo() { return poolInfo; },
  };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;

export function finish(file: string) {
  const c: Record<string, number> = {};
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  console.log("\n================ SUMMARY ================");
  console.log(c);
  const s: Record<string, number> = {};
  for (const r of rows) if (r.status) s[r.status] = (s[r.status] ?? 0) + 1;
  console.log("by status:", s);
  for (const r of rows.filter((x) => x.verdict === "EXPLOITABLE")) console.log(`  ⚠️  [${r.id}] ${r.title} — ${r.note ?? ""}${r.status ? "  {" + r.status + "}" : "  {NO STATUS — unexpected}"}`);
  for (const r of rows.filter((x) => x.verdict === "ERROR")) console.log(`  ❌ [${r.id}] ${r.title} — ${r.note ?? ""}`);
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log("results →", file);
}
