// Единая точка конфигурации для всех скриптов.
//
// PROGRAM_ID берётся из IDL (target/idl/...json -> "address"), чтобы после
// `anchor build` с новым keypair'ом ничего не пришлось править руками.
// GOVERNANCE_MINT — монета государства (голосование), только из переменной
// окружения (создаётся при деплое, см. scripts/create_mint.ts). Дефолта нет специально.
// TREASURY_MINT — актив казны (парный актив пула Meteora). По умолчанию wSOL;
// для USDC/USDT задайте TREASURY_MINT=<mint> (обычный Token Program).
//
//   export GOVERNANCE_MINT=<mint>
//   export TREASURY_MINT=<mint>     # необязательно, по умолчанию wSOL
//   export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
//   export ANCHOR_WALLET=~/.config/solana/id.json

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Connection } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

import { readIdl } from "./idl";
export { readIdl, IDL_PATH } from "./idl";
/** Token program of the GOVERNANCE coin (Token-2022: metadata extension, no transfer tax). */
export const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;
/** Token program of the TREASURY asset (wSOL / USDC / USDT are classic SPL tokens). */
export const TREASURY_PROGRAM = TOKEN_PROGRAM_ID;
export const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID;
/** Meteora DAMM v2 (cp-amm). */
export const METEORA_CP_AMM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Set ${key} (env var). No default on purpose.`);
  return v;
}

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || readIdl().address
);
export const GOVERNANCE_MINT = new PublicKey(requireEnv("GOVERNANCE_MINT"));
export const TREASURY_MINT = process.env.TREASURY_MINT ? new PublicKey(process.env.TREASURY_MINT) : NATIVE_MINT;

/** "1.5" + 9 decimals -> 1500000000n (exact, no floating point). */
export function parseUnits(text: string, decimals: number): bigint {
  const [whole, frac = ""] = text.trim().split(".");
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac)) || frac.length > decimals) throw new Error(`bad amount "${text}" for ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", os.homedir()) : p;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(path), "utf8")))
  );
}

// ---------------- flaky public RPCs: repeat a request when the connection is cut ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT_NETWORK = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|UND_ERR|other side closed|network|terminated/i;
export function isTransientNetworkError(e: any): boolean {
  return TRANSIENT_NETWORK.test([e?.message, e?.cause?.message, e?.cause?.code, e?.code].filter(Boolean).join(" "));
}
/**
 * `fetch` for a Connection. The public mainnet RPC cuts about one request in twenty ("fetch failed", ECONNRESET, HTTP 5xx):
 * the request is repeated up to 5 times with a growing pause. Safe for every JSON-RPC call: even sendTransaction carries the same signed bytes,
 * and a transaction can land only once (an "already processed" answer is handled in sendAndConfirm below).
 */
export const retryFetch = async (input: any, init?: any): Promise<any> => {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(input, init);
      if (res.status >= 500 && i < 5) { try { await res.arrayBuffer(); } catch { /* drain */ } await sleep(800 * (i + 1)); continue; }
      return res;
    } catch (e: any) {
      if (i >= 5 || !isTransientNetworkError(e)) throw e;
      await sleep(800 * (i + 1));
    }
  }
};
/** A Connection that survives cut connections (use instead of `new Connection(url, commitment)`). */
export function makeConnection(url: string, commitment: "processed" | "confirmed" | "finalized" = "confirmed"): Connection {
  return new Connection(url, { commitment, fetch: retryFetch });
}

/** AnchorProvider. With KEYPAIR set (or passed) — signs with that key; else ANCHOR_WALLET. */
export function getProvider(keypairPath?: string): anchor.AnchorProvider {
  const kp = keypairPath ?? process.env.KEYPAIR;
  if (kp) {
    const wallet = new anchor.Wallet(loadKeypair(kp));
    const conn = makeConnection(process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899", "confirmed");
    const p = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
    anchor.setProvider(p);
    return p;
  }
  // the same as AnchorProvider.env() (url from ANCHOR_PROVIDER_URL, key from ANCHOR_WALLET), but with the retrying fetch
  const url = process.env.ANCHOR_PROVIDER_URL;
  if (!url) throw new Error("ANCHOR_PROVIDER_URL is not defined");
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) throw new Error("ANCHOR_WALLET is not defined");
  const opts = anchor.AnchorProvider.defaultOptions();
  const p = new anchor.AnchorProvider(makeConnection(url, opts.commitment as any), new anchor.Wallet(loadKeypair(walletPath)), opts);
  anchor.setProvider(p);
  return p;
}

export function loadProgram(provider: anchor.AnchorProvider): any {
  return new anchor.Program(readIdl(), provider);
}

// ---------------- PDA derivations ----------------

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config"), GOVERNANCE_MINT.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** The treasury: an ATA of the treasury asset owned by the Config PDA. */
export function treasuryAta(): PublicKey {
  return getAssociatedTokenAddressSync(TREASURY_MINT, configPda(), true, TREASURY_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** A wallet's account for the TREASURY asset (salaries, spends and payouts arrive here). */
export function treasuryAtaOf(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(TREASURY_MINT, owner, true, TREASURY_PROGRAM, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** Config-owned governance-coin account Meteora's claim needs as the (empty) "token A" destination. */
export function feeAAccount(): PublicKey {
  return getAssociatedTokenAddressSync(GOVERNANCE_MINT, configPda(), true, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/** A wallet's GOVERNANCE-coin account (vote weight is read from it). */
export function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    GOVERNANCE_MINT,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

// ---------------- Meteora DAMM v2 helpers ----------------

export const METEORA_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const METEORA_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], METEORA_CP_AMM)[0];

/** cp-amm position account of a position NFT mint. */
export function meteoraPositionPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], METEORA_CP_AMM)[0];
}
/** cp-amm token account that holds the position NFT (its token authority = the position owner). */
export function meteoraPositionNftAccountPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), nftMint.toBuffer()], METEORA_CP_AMM)[0];
}
/** Token vaults of a cp-amm pool, read from its raw data (offsets 232 / 264). */
export async function readPoolVaults(connection: Connection, pool: PublicKey): Promise<{ vaultA: PublicKey; vaultB: PublicKey }> {
  const info = await connection.getAccountInfo(pool, "confirmed");
  if (!info) throw new Error("pool account not found: " + pool.toBase58());
  return { vaultA: new PublicKey(info.data.subarray(232, 264)), vaultB: new PublicKey(info.data.subarray(264, 296)) };
}

function u256le(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}
function u128le(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}
function u64le2(data: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[offset + i]);
  return v;
}

/**
 * Trading fee that has accrued on the state's pool position but is not claimed yet, computed from the raw
 * cp-amm accounts (same formula as Meteora: pending + (fee-per-liquidity now - checkpoint) * liquidity / 2^128).
 * Offsets include the 8-byte discriminator. feeA is always 0 in "fee only in B" pools.
 */
export async function readPendingPoolFee(
  connection: Connection,
  pool: PublicKey,
  position: PublicKey
): Promise<{ feeA: bigint; feeB: bigint }> {
  const [pi, xi] = await Promise.all([connection.getAccountInfo(pool, "confirmed"), connection.getAccountInfo(position, "confirmed")]);
  if (!pi || !xi) throw new Error("pool or position account not found");
  const pd = pi.data, xd = xi.data;
  const liquidity = u128le(xd, 152) + u128le(xd, 168) + u128le(xd, 184); // unlocked + vested + permanently locked
  const feeA = u64le2(xd, 136) + (((u256le(pd, 488) - u256le(xd, 72)) * liquidity) >> 128n);
  const feeB = u64le2(xd, 144) + (((u256le(pd, 520) - u256le(xd, 104)) * liquidity) >> 128n);
  return { feeA, feeB };
}

export function milestoneFundPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone_fund"), configPda().toBuffer()],
    PROGRAM_ID
  )[0];
}

function u64le(n: anchor.BN | number | bigint | string): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n.toString()));
  return buf;
}

export function proposalPda(id: anchor.BN | number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), configPda().toBuffer(), u64le(id)],
    PROGRAM_ID
  )[0];
}

export function voterSnapshotPda(proposal: PublicKey, voter: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("voter_snapshot"), proposal.toBuffer(), voter.toBuffer()],
    PROGRAM_ID
  )[0];
}

/** role: 1 = finance, 2 = culture. Tracker is per-role, not per-wallet. */
export function spendTrackerPda(role: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("spend_tracker"), configPda().toBuffer(), Buffer.from([role])],
    PROGRAM_ID
  )[0];
}

export function milestonePda(n: anchor.BN | number | bigint | string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone"), configPda().toBuffer(), u64le(n)],
    PROGRAM_ID
  )[0];
}

/** The "salary already paid" record is kept per ROLE: 0 = president, 1 = finance minister, 2 = culture minister. */
export function payrollPda(role: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("payroll"), configPda().toBuffer(), Buffer.from([role])], PROGRAM_ID)[0];
}

export function milestoneSnapPda(milestone: PublicKey, holder: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone_snap"), milestone.toBuffer(), holder.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ---------------- High-level helpers ----------------

/** The pool vault excluded from the voting base (null until register_pool). */
export function excludedAccountOf(cfg: any): PublicKey | null {
  const k: PublicKey = cfg.quorumExcludedAccount;
  return k && !k.equals(PublicKey.default) ? k : null;
}

export type ProposalType =
  | 0 // SPEND
  | 1 // ChangePresident
  | 2 // AppointFinance
  | 3 // AppointCulture
  | 4 // ChangeParam
  | 5 // ChangeOwnersAuthority
  | 6; // DepositToMilestoneFund

/** Create a proposal from the provider wallet. Returns the assigned id + PDA. */
export async function createProposal(
  program: any,
  provider: anchor.AnchorProvider,
  args: {
    type: ProposalType;
    target: PublicKey;
    amount?: anchor.BN | number | bigint | string;
    paramKey?: number;
    reason: string;
  }
): Promise<{ id: anchor.BN; pda: PublicKey }> {
  const me = provider.wallet.publicKey;
  const cfg = await program.account.config.fetch(configPda());
  const id: anchor.BN = cfg.proposalCount;
  const pda = proposalPda(id);
  await program.methods
    .createProposal(
      args.type,
      args.target,
      new anchor.BN((args.amount ?? 0).toString()),
      args.paramKey ?? 0,
      args.reason
    )
    .accounts({
      creator: me,
      config: configPda(),
      governanceMint: GOVERNANCE_MINT,
      creatorTokenAccount: ata(me),
      treasury: treasuryAta(),
      quorumExcluded: excludedAccountOf(cfg),
      proposal: pda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { id, pda };
}

/**
 * owners_authority posts a snapshot for `voter` — BEFORE `openVoting`.
 * `weight` is the amount the owner's ONE scan of the holders saw (whole scan taken at the same moment; keep the
 * numbers and post exactly those). The program only refuses a weight of 0 or more than the voter holds right now.
 * Without `weight` the voter's balance at this moment is used (fine for a quick single-voter test, NOT for a real
 * multi-holder vote: read all balances once first, see scripts/scan_holders.ts).
 */
export async function postSnapshot(
  program: any,
  ownerProvider: anchor.AnchorProvider,
  proposalId: anchor.BN | number | bigint | string,
  voter: PublicKey,
  weight?: anchor.BN | number | bigint | string,
  tokenAccount?: PublicKey // the voter's account that holds the coins (default: the associated one)
): Promise<string> {
  const pda = proposalPda(proposalId);
  const acct = tokenAccount ?? ata(voter);
  let w = weight;
  if (w === undefined) {
    const bal = await program.provider.connection.getTokenAccountBalance(acct, "confirmed");
    w = bal.value.amount;
  }
  return program.methods
    .postVoterSnapshot(new anchor.BN(proposalId.toString()), voter, new anchor.BN(w.toString()))
    .accounts({
      owner: ownerProvider.wallet.publicKey,
      config: configPda(),
      proposal: pda,
      voterTokenAccount: acct,
      voterSnapshot: voterSnapshotPda(pda, voter),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/**
 * owners_authority closes the enrolment and starts the voting clock (all snapshots must be posted first).
 * Freezes the quorum base (supply minus the pool vault balance right now). After this, votes are accepted and
 * snapshots are refused.
 */
export async function openVoting(
  program: any,
  ownerProvider: anchor.AnchorProvider,
  proposalId: anchor.BN | number | bigint | string
): Promise<string> {
  const cfg = await program.account.config.fetch(configPda());
  return program.methods
    .openVoting(new anchor.BN(proposalId.toString()))
    .accounts({
      owner: ownerProvider.wallet.publicKey,
      config: configPda(),
      governanceMint: GOVERNANCE_MINT,
      proposal: proposalPda(proposalId),
      quorumExcluded: excludedAccountOf(cfg),
    })
    .rpc();
}

/** Cast a vote with an already-posted snapshot (voting must have been opened). */
export async function castVote(
  program: any,
  voterProvider: anchor.AnchorProvider,
  proposalId: anchor.BN | number | bigint | string,
  support: boolean
): Promise<string> {
  const pda = proposalPda(proposalId);
  const voter = voterProvider.wallet.publicKey;
  return program.methods
    .vote(new anchor.BN(proposalId.toString()), support)
    .accounts({
      voter,
      config: configPda(),
      proposal: pda,
      voterSnapshot: voterSnapshotPda(pda, voter),
    })
    .rpc();
}

/**
 * Execute a proposal. owners_authority only.
 * - SPEND: pass `recipient` (owner must equal proposal.target).
 * - DEPOSIT_TO_MILESTONE_FUND: pass `milestoneFund: true`.
 */
export async function executeProposal(
  program: any,
  ownerProvider: anchor.AnchorProvider,
  proposalId: anchor.BN | number | bigint | string,
  opts: { recipient?: PublicKey; milestoneFund?: boolean } = {}
): Promise<string> {
  return program.methods
    .executeProposal(new anchor.BN(proposalId.toString()))
    .accounts({
      executor: ownerProvider.wallet.publicKey,
      config: configPda(),
      treasuryMint: TREASURY_MINT,
      proposal: proposalPda(proposalId),
      treasury: treasuryAta(),
      recipientTokenAccount: opts.recipient ?? null,
      milestoneFund: opts.milestoneFund ? milestoneFundPda() : null,
      tokenProgram: TREASURY_PROGRAM,
    })
    .rpc();
}

/** Current chain time (seconds): the Clock sysvar, i.e. what the program itself sees (unix_timestamp at offset 32). */
export async function chainNow(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "confirmed");
  return info ? Number(info.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000);
}

export async function waitUntilChainTime(connection: Connection, target: number): Promise<void> {
  for (;;) {
    const now = await chainNow(connection);
    const left = target - now;
    if (left <= 0) return;
    console.log(`  ...waiting ~${left}s (validator clock)`);
    await new Promise((r) => setTimeout(r, Math.min(left, 10) * 1000));
  }
}

export { anchor, PublicKey, SystemProgram };

// ---------------- optional: confirm over plain HTTP (public RPCs rate-limit websockets) ----------------
// HTTP_CONFIRM=1 makes every provider.sendAndConfirm() poll getSignatureStatuses and re-send with a fresh blockhash when one expires.
if (process.env.HTTP_CONFIRM === "1") {
  const sleepMs = sleep;
  (anchor.AnchorProvider.prototype as any).sendAndConfirm = async function (this: any, tx: any, signers?: Keypair[], opts?: any) {
    tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
    for (let i = 0; ; i++) {
      try {
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.signatures = [];
        (signers ?? []).forEach((k: Keypair) => tx.partialSign(k));
        const signed = await this.wallet.signTransaction(tx);
        const first = signed.signature ?? (Array.isArray(signed.signatures) ? (signed.signatures[0]?.signature ?? signed.signatures[0]) : null);
        const localSig: string = first ? anchor.utils.bytes.bs58.encode(first) : "";   // known before sending: lets us follow a transaction whose answer got lost
        let sig: string;
        try {
          sig = await this.connection.sendRawTransaction(signed.serialize(), { skipPreflight: (opts ?? this.opts)?.skipPreflight ?? false, preflightCommitment: "confirmed" });
        } catch (e: any) {
          // the first copy may have reached the cluster although its answer was lost: the same bytes sent again are then "already processed" - follow it
          if (localSig && /already (been )?processed|AlreadyProcessed/i.test(String(e?.message ?? e) + " " + String((e?.logs ?? []).join?.(" ") ?? ""))) sig = localSig;
          else throw e;
        }
        const t0 = Date.now();
        for (;;) {
          let st: any = null, height = 0;
          try {
            st = (await this.connection.getSignatureStatuses([sig])).value[0];
            if (!(st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) && !st?.err) height = await this.connection.getBlockHeight("confirmed");
          } catch (e: any) {
            if (isTransientNetworkError(e) && Date.now() - t0 < 180_000) { await sleepMs(1500); continue; }   // one failed poll must not abort a sent transaction
            throw new Error("could not confirm (network): the transaction " + sig + " was sent and may still land - check it on the chain before repeating. " + (e?.message ?? e));
          }
          if (st?.err) throw new Error("Transaction " + sig + " failed: " + JSON.stringify(st.err));
          if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
          if (height > lastValidBlockHeight) throw new Error("block height exceeded");
          await sleepMs(700);
        }
      } catch (e: any) {
        if (i < 6 && /expired|block height exceeded|Blockhash not found/i.test(String(e?.message ?? e))) { await sleepMs(1500); continue; }
        throw e;
      }
    }
  };
}
