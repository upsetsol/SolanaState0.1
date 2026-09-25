// Fund the treasury with the treasury asset (wSOL by default; USDC/USDT via TREASURY_MINT).
// Normally the treasury is fed by the pool fee (claim_pool_fees); this is for a starting
// balance or tests. For wSOL the SOL is wrapped straight into the treasury account.
//
//   GOVERNANCE_MINT=<mint>
//   TREASURY_MINT=<mint>     optional, default wSOL
//   AMOUNT=1                 in whole units of the treasury asset (1 = 1 SOL / 1 USDC)
//   (signer = the wallet paying it in)

import { NATIVE_MINT, getMint, createSyncNativeInstruction, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, getAccount } from "@solana/spl-token";
import { Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { parseUnits, getProvider, TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM, treasuryAta, treasuryAtaOf, configPda } from "./lib/env";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const mint = await getMint(conn, TREASURY_MINT, "confirmed", TREASURY_PROGRAM);
  const amount = parseUnits(process.env.AMOUNT ?? "1", mint.decimals);

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, treasuryAta(), configPda(), TREASURY_MINT, TREASURY_PROGRAM, ATA_PROGRAM)
  );
  if (TREASURY_MINT.equals(NATIVE_MINT)) {
    tx.add(
      SystemProgram.transfer({ fromPubkey: me, toPubkey: treasuryAta(), lamports: Number(amount) }),
      createSyncNativeInstruction(treasuryAta(), TREASURY_PROGRAM)
    );
  } else {
    tx.add(createTransferCheckedInstruction(treasuryAtaOf(me), TREASURY_MINT, treasuryAta(), me, amount, mint.decimals, [], TREASURY_PROGRAM));
  }
  const sig = await sendAndConfirmTransaction(conn, tx, [(provider.wallet as any).payer], { commitment: "confirmed" });
  const t = await getAccount(conn, treasuryAta(), "confirmed", TREASURY_PROGRAM);
  console.log("fund_treasury tx:", sig, "| treasury balance (raw):", t.amount.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
