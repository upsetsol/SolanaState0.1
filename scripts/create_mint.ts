// Creates the governance mint: Token-2022 with the TransferFee extension.
//
// CRITICAL: the withheld-fee authority is set to the program's Config PDA
// (derived from this very mint + PROGRAM_ID), so harvest_fees can later sweep
// the tax into the treasury. That's why the mint keypair is generated first,
// the PDA computed from it, and only then the mint initialised.
//
//   PROGRAM_ID=<program>        (optional — defaults to IDL address)
//   FEE_BPS=500                 (optional — 5% transfer tax, default)
//   MAX_FEE=<raw>               (optional — per-transfer fee cap, default: none)
//   DECIMALS=9                  (optional)
//   INITIAL_SUPPLY=<ui>         (optional — mint this many tokens to the payer)
//   OUT=./.mint.json            (optional — where to save the mint keypair)
//
// After running: `export GOVERNANCE_MINT=<printed address>`

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import { readIdl } from "./lib/env";

function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? path.replace("~", os.homedir()) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

async function main() {
  const programId = new PublicKey(process.env.PROGRAM_ID || readIdl().address);
  const feeBps = Number(process.env.FEE_BPS ?? "500");
  const decimals = Number(process.env.DECIMALS ?? "9");
  const maxFee = BigInt(process.env.MAX_FEE ?? "18446744073709551615"); // u64::MAX = no cap
  const outPath = process.env.OUT ?? "./.mint.json";

  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const payer = loadKeypair(process.env.ANCHOR_WALLET || "~/.config/solana/id.json");

  const mint = Keypair.generate();
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.publicKey.toBuffer()],
    programId
  );

  console.log("Program:            ", programId.toBase58());
  console.log("Mint:               ", mint.publicKey.toBase58());
  console.log("Config PDA:         ", configPda.toBase58());
  console.log("Fee:                ", feeBps, "bps");
  console.log("transfer-fee config authority: payer", payer.publicKey.toBase58());
  console.log("withdraw-withheld authority:   Config PDA", configPda.toBase58());

  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeTransferFeeConfigInstruction(
      mint.publicKey,
      payer.publicKey, // transfer-fee config authority (can retune the fee later)
      configPda, // withdraw-withheld authority — MUST be the Config PDA
      feeBps,
      maxFee,
      TOKEN_2022_PROGRAM_ID
    ),
    createInitializeMintInstruction(
      mint.publicKey,
      decimals,
      payer.publicKey, // mint authority (for the initial distribution)
      null, // freeze authority
      TOKEN_2022_PROGRAM_ID
    )
  );

  if (process.env.INITIAL_SUPPLY) {
    const raw = BigInt(process.env.INITIAL_SUPPLY) * 10n ** BigInt(decimals);
    const payerAta = getAssociatedTokenAddressSync(
      mint.publicKey,
      payer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        payerAta,
        payer.publicKey,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      createMintToInstruction(
        mint.publicKey,
        payerAta,
        payer.publicKey,
        raw,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    console.log("Initial supply:     ", process.env.INITIAL_SUPPLY, "->", payerAta.toBase58());
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint], {
    commitment: "confirmed",
  });
  console.log("\ncreate_mint tx:", sig);

  fs.writeFileSync(outPath, JSON.stringify(Array.from(mint.secretKey)));
  console.log("Mint keypair saved to", outPath);
  console.log("\nNext:  export GOVERNANCE_MINT=" + mint.publicKey.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
