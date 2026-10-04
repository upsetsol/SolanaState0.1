// Creates the governance mint: the state's own voting coin.
//
// Token-2022 with the MetadataPointer + TokenMetadata extensions (name, symbol, logo shown by
// wallets and explorers). NO transfer tax: the treasury is fed by the pool trading fee instead
// (see scripts/create_pool.ts). Mint authority stays with the payer so the supply can be handed
// out; renounce it afterwards (`spl-token authorize <mint> mint --disable`) once distribution is done.
//
//   NAME="Test 1"               token name (default "Test 1")
//   SYMBOL=TEST1                token symbol (default "TEST1")
//   URI=<https://...json>       metadata JSON with the logo (optional, default empty)
//   DECIMALS=9                  (optional)
//   INITIAL_SUPPLY=<ui>         (optional — mint this many tokens to the payer)
//   OUT=./.mint.json            (optional — where to save the mint keypair)
//
// Safe to run again: the key file is written BEFORE the transaction is sent and is the identity of the coin. If OUT already exists the script reuses it:
// when that coin is already on chain it does nothing (no second coin), when it is not (an interrupted run) it creates it with the same key.
//
// After running: `export GOVERNANCE_MINT=<printed address>`

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TYPE_SIZE,
  LENGTH_SIZE,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, TokenMetadata } from "@solana/spl-token-metadata";
import * as fs from "fs";
import * as os from "os";

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

function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? path.replace("~", os.homedir()) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const decimals = Number(process.env.DECIMALS ?? "9");
  const outPath = process.env.OUT ?? "./.mint.json";
  const name = process.env.NAME ?? "Test 1";
  const symbol = process.env.SYMBOL ?? "TEST1";
  const uri = process.env.URI ?? "";

  const connection = new Connection(process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", { commitment: "confirmed", fetch: retryFetch as any });
  const payer = loadKeypair(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");
  const keyFile = outPath.startsWith("~") ? outPath.replace("~", os.homedir()) : outPath;
  const haveKey = fs.existsSync(keyFile);
  const mint = haveKey ? loadKeypair(keyFile) : Keypair.generate();
  if (haveKey && (await connection.getAccountInfo(mint.publicKey, "confirmed"))) {
    console.log("Mint:    ", mint.publicKey.toBase58(), "(from", keyFile + ") already exists on chain - NOT creating a second coin. Use another OUT=<file> for a new coin.");
    console.log("\nNext:  export GOVERNANCE_MINT=" + mint.publicKey.toBase58());
    return;
  }

  const metadata: TokenMetadata = {
    mint: mint.publicKey,
    name,
    symbol,
    uri,
    additionalMetadata: [],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metadataLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen + metadataLen);

  console.log("Mint:    ", mint.publicKey.toBase58());
  console.log("Name:    ", name, "| symbol:", symbol, "| decimals:", decimals);
  console.log("Transfer tax: none (the treasury is fed by the pool fee)");

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // the metadata lives in the mint account itself
    createInitializeMetadataPointerInstruction(mint.publicKey, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey, // mint authority (for the initial distribution)
      null, // freeze authority: none
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      metadata: mint.publicKey,
      updateAuthority: payer.publicKey,
      mint: mint.publicKey,
      mintAuthority: payer.publicKey,
      name,
      symbol,
      uri,
    })
  );

  if (process.env.INITIAL_SUPPLY) {
    const raw = BigInt(process.env.INITIAL_SUPPLY) * 10n ** BigInt(decimals);
    const payerAta = getAssociatedTokenAddressSync(mint.publicKey, payer.publicKey, false, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, payerAta, payer.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
      createMintToInstruction(mint.publicKey, payerAta, payer.publicKey, raw, [], TOKEN_2022_PROGRAM_ID)
    );
    console.log("Initial supply:", process.env.INITIAL_SUPPLY, "->", payerAta.toBase58());
  }

  // save the coin's key FIRST: whatever happens to the transaction, the address can never be lost
  if (!haveKey) fs.writeFileSync(keyFile, JSON.stringify(Array.from(mint.secretKey)), { mode: 0o600, flag: "wx" });
  console.log("Mint keypair saved to", keyFile);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.sign(payer, mint);
  const sig = await connection.sendRawTransaction(tx.serialize());
  // confirm by polling over HTTP (websocket subscriptions get rate-limited on public RPCs)
  for (;;) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("create_mint failed: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await connection.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      if (await connection.getAccountInfo(mint.publicKey, "confirmed")) break; // it landed after all
      throw new Error("the transaction did not land (block height exceeded). Nothing was created; run the same command again (the key file " + keyFile + " is reused). tx " + sig);
    }
    await sleep(700);
  }
  console.log("\ncreate_mint tx:", sig);
  console.log("\nNext:  export GOVERNANCE_MINT=" + mint.publicKey.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
