// Send governance coins from KEYPAIR to another wallet (creates its token account if needed).
//   GOVERNANCE_MINT=<mint>  KEYPAIR=~/sender.json  TO=<wallet address>  AMOUNT=<whole coins>  CONFIRM=yes (without it: dry run)
import { PublicKey, Transaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, getAccount, getMint } from "@solana/spl-token";
import { getProvider, parseUnits, GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM } from "./lib/env";
import { requireConfirm, retry, fmt } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  if (!process.env.TO) throw new Error("set TO=<wallet address>");
  const to = new PublicKey(process.env.TO);
  const gov = await retry(() => getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  const amount = parseUnits(process.env.AMOUNT ?? "0", gov.decimals);
  if (amount <= 0n) throw new Error("set AMOUNT=<whole coins>");
  const from = getAssociatedTokenAddressSync(GOVERNANCE_MINT, me, false, TOKEN_PROGRAM, ATA_PROGRAM);
  const dest = getAssociatedTokenAddressSync(GOVERNANCE_MINT, to, true, TOKEN_PROGRAM, ATA_PROGRAM);
  const bal = (await retry(() => getAccount(conn, from, "confirmed", TOKEN_PROGRAM))).amount;
  console.log(`from ${me.toBase58()} (has ${fmt(bal, gov.decimals, 2)} coins)\nto   ${to.toBase58()}\nsend ${fmt(amount, gov.decimals, 2)} coins`);
  if (bal < amount) throw new Error("not enough coins on the sender");
  requireConfirm("send the coins");
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, dest, to, GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM),
    createTransferCheckedInstruction(from, GOVERNANCE_MINT, dest, me, amount, gov.decimals, [], TOKEN_PROGRAM)
  );
  console.log("DONE, tx", await provider.sendAndConfirm(tx));
}
main().catch((e) => { console.error(e); process.exit(1); });
