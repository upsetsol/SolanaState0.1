// Реальный своп через созданный пул: продаём наш governance-токен (5% fee)
// за wSOL. Это и есть главный тест — как налог ведёт себя при торговле
// через настоящий DEX, не при прямом переводе между кошельками.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";

const GOVERNANCE_MINT = new PublicKey("BBQu1FSaMb5WZxHierR5ocs6EwMMzhcKbWGZFhaTMR3k");
const POOL = new PublicKey("AunHtUVCVGdLybtgRP4oNo1KBXx6sn2v8pkssNpX5WnR");

async function main() {
  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed"
  );
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")))
  );
  const cpAmm = new CpAmm(connection);

  const myTokenAccount = getAssociatedTokenAddressSync(
    GOVERNANCE_MINT, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID
  );

  const before = await getAccount(connection, myTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Баланс токена ДО свопа:", before.amount.toString());

  const poolState: any = await cpAmm.fetchPoolState(POOL);

  const amountIn = new BN("1000000").mul(new BN(10).pow(new BN(9))); // 1,000,000 токенов

  const tx = await cpAmm.swap({
    payer: wallet.publicKey,
    pool: POOL,
    inputTokenMint: GOVERNANCE_MINT,
    outputTokenMint: NATIVE_MINT,
    amountIn,
    minimumAmountOut: new BN(0), // тестово, без защиты от проскальзывания
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: TOKEN_2022_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  });

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet);

  console.log("Отправляем своп...");
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");
  console.log("✅ Своп прошёл, tx:", sig);

  const after = await getAccount(connection, myTokenAccount, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("Баланс токена ПОСЛЕ свопа:", after.amount.toString());
  console.log("Реально ушло с кошелька:", (BigInt(before.amount) - BigInt(after.amount)).toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
