// Shared helpers for the DEX experiments. RPC comes from the RPC env var (never hardcode keys).
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, getMintLen,
  createInitializeMintInstruction, createInitializeTransferFeeConfigInstruction,
  createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync, getMint, getAccount, unpackAccount, getTransferFeeAmount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

export const RPC = process.env.RPC || "https://api.devnet.solana.com";
// Public RPCs drop connections now and then (ECONNRESET / 429): retry the HTTP call a few times.
const retryFetch = (async (input: any, init?: any) => {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(input, init);
      if ((r.status === 429 || r.status >= 500) && i < 6) { await new Promise((res) => setTimeout(res, 800 * (i + 1))); continue; }
      return r;
    } catch (e) {
      if (i >= 6) throw e;
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
}) as typeof fetch;
export const connection = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch });
export const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync((process.env.ANCHOR_WALLET || "~/.config/solana/id.json").replace("~", os.homedir()), "utf8")))
);
export const DEC = 9;
const MINT_FILE = ".dex-mint.json"; // gitignored: keypair of the throw-away test token

export async function send(tx: Transaction, signers: Keypair[]): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      return await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    } catch (e: any) {
      if (i < 3 && /expired|block height exceeded|not found/i.test(String(e?.message))) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      throw e;
    }
  }
}

/** Token-2022 test token with the SAME setup as production: 5% transfer fee, fee authority removed. */
export async function getOrCreateMint(): Promise<PublicKey> {
  if (fs.existsSync(MINT_FILE)) {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(MINT_FILE, "utf8"))));
    try { await getMint(connection, kp.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID); return kp.publicKey; } catch { /* recreate */ }
  }
  const mint = Keypair.generate();
  const len = getMintLen([ExtensionType.TransferFeeConfig]);
  const rent = await connection.getMinimumBalanceForRentExemption(len);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey, space: len, lamports: rent, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeTransferFeeConfigInstruction(mint.publicKey, null, payer.publicKey, 500, BigInt("18446744073709551615"), TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DEC, payer.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, payer.publicKey, 1_000_000_000n * 10n ** BigInt(DEC), [], TOKEN_2022_PROGRAM_ID)
  );
  await send(tx, [payer, mint]);
  fs.writeFileSync(MINT_FILE, JSON.stringify(Array.from(mint.secretKey)));
  console.log("created test token (Token-2022, 5% fee):", mint.publicKey.toBase58());
  return mint.publicKey;
}

export async function tokenBalance(owner: PublicKey, mint: PublicKey): Promise<bigint> {
  try { return (await getAccount(connection, getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount; } catch { return 0n; }
}

/** Amount of transfer tax currently withheld on an arbitrary token account (0 if none). */
export async function withheldOn(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, "confirmed");
  if (!info) return 0n;
  const u = unpackAccount(account, info, TOKEN_2022_PROGRAM_ID);
  const f = getTransferFeeAmount(u);
  return f ? f.withheldAmount : 0n;
}

export const ui = (raw: bigint | number | string, dec = DEC) => (Number(raw) / 10 ** dec).toLocaleString("en-US", { maximumFractionDigits: 4 });
