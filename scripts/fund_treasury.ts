// Initial treasury funding: move a share of the total supply (default 5%) from
// the deployer's token account into the treasury. The Token-2022 transfer tax
// applies, so the treasury receives the amount minus the fee.
//
//   GOVERNANCE_MINT=<mint>
//   FUND_BPS=500          share of total supply, in bps (default 500 = 5%)
//   (signer = the wallet holding the supply, normally the deployer)

import {
  getMint,
  getTransferFeeConfig,
  createTransferCheckedWithFeeInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";
import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getProvider, GOVERNANCE_MINT, treasuryAta, ata, TOKEN_PROGRAM, ATA_PROGRAM, configPda } from "./lib/env";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const fundBps = BigInt(process.env.FUND_BPS ?? "500");

  const mint = await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  const amount = (mint.supply * fundBps) / 10_000n;

  const cfg = getTransferFeeConfig(mint);
  const epoch = BigInt((await conn.getEpochInfo()).epoch);
  const f = cfg && epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : cfg?.olderTransferFee;
  const bps = BigInt(f?.transferFeeBasisPoints ?? 0);
  const max = BigInt(f?.maximumFee ?? 0);
  let fee = (amount * bps + 9_999n) / 10_000n;
  if (fee > max) fee = max;

  console.log(`Supply ${mint.supply}, funding ${amount} (${fundBps} bps), tax ${fee}`);
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, treasuryAta(), configPda(), GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM),
    createTransferCheckedWithFeeInstruction(ata(me), GOVERNANCE_MINT, treasuryAta(), me, amount, mint.decimals, fee, [], TOKEN_PROGRAM)
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [(provider.wallet as any).payer], { commitment: "confirmed" });
  const t = await getAccount(conn, treasuryAta(), "confirmed", TOKEN_PROGRAM);
  console.log("fund_treasury tx:", sig, "| treasury balance:", t.amount.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
