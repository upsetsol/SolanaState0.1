// Единая точка конфигурации для всех скриптов.
//
// PROGRAM_ID берётся из IDL (target/idl/...json -> "address"), чтобы после
// `anchor build` с новым keypair'ом ничего не пришлось править руками.
// GOVERNANCE_MINT — только из переменной окружения (создаётся при деплое,
// см. scripts/create_mint.ts). Дефолта нет специально.
//
//   export GOVERNANCE_MINT=<mint>
//   export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
//   export ANCHOR_WALLET=~/.config/solana/id.json

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Connection } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

export const IDL_PATH = "./target/idl/onchain_state_solana.json";
export const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;
export const ATA_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ID;

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Set ${key} (env var). No default on purpose.`);
  return v;
}

export function readIdl(): any {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`${IDL_PATH} not found — run \`anchor build\` first.`);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
}

export const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || readIdl().address
);
export const GOVERNANCE_MINT = new PublicKey(requireEnv("GOVERNANCE_MINT"));

export function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace("~", os.homedir()) : p;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(expandHome(path), "utf8")))
  );
}

/** AnchorProvider. With KEYPAIR set (or passed) — signs with that key; else ANCHOR_WALLET. */
export function getProvider(keypairPath?: string): anchor.AnchorProvider {
  const kp = keypairPath ?? process.env.KEYPAIR;
  if (kp) {
    const wallet = new anchor.Wallet(loadKeypair(kp));
    const conn = new Connection(
      process.env.ANCHOR_PROVIDER_URL || "http://localhost:8899",
      "confirmed"
    );
    const p = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
    anchor.setProvider(p);
    return p;
  }
  const p = anchor.AnchorProvider.env();
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

export function treasuryAta(): PublicKey {
  return getAssociatedTokenAddressSync(
    GOVERNANCE_MINT,
    configPda(),
    true,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
}

export function ata(owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    GOVERNANCE_MINT,
    owner,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
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

export function milestoneSnapPda(milestone: PublicKey, holder: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("milestone_snap"), milestone.toBuffer(), holder.toBuffer()],
    PROGRAM_ID
  )[0];
}

// ---------------- High-level helpers ----------------

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
      governanceMint: GOVERNANCE_MINT,
      creatorTokenAccount: ata(me),
      config: configPda(),
      treasury: treasuryAta(),
      proposal: pda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { id, pda };
}

/**
 * owners_authority posts a snapshot for `voter`. Weight is read on-chain from
 * the voter's real token account — not passed in. Must be done BEFORE anyone
 * votes on this proposal.
 */
export async function postSnapshot(
  program: any,
  ownerProvider: anchor.AnchorProvider,
  proposalId: anchor.BN | number | bigint | string,
  voter: PublicKey
): Promise<string> {
  const pda = proposalPda(proposalId);
  return program.methods
    .postVoterSnapshot(new anchor.BN(proposalId.toString()), voter)
    .accounts({
      owner: ownerProvider.wallet.publicKey,
      config: configPda(),
      proposal: pda,
      voterTokenAccount: ata(voter),
      voterSnapshot: voterSnapshotPda(pda, voter),
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Cast a vote with an already-posted snapshot. */
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
      governanceMint: GOVERNANCE_MINT,
      config: configPda(),
      proposal: proposalPda(proposalId),
      treasury: treasuryAta(),
      recipientTokenAccount: opts.recipient ?? null,
      milestoneFund: opts.milestoneFund ? milestoneFundPda() : null,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
}

/** Current chain time by the validator's clock (seconds). */
export async function chainNow(connection: Connection): Promise<number> {
  const slot = await connection.getSlot();
  const t = await connection.getBlockTime(slot);
  return t ?? Math.floor(Date.now() / 1000);
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
