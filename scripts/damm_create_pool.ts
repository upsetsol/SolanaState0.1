// Создаём реальный DAMM v2 пул: наш governance-токен (Token-2022, 5% fee) + SOL.
// Это самый новый и наименее проверенный API за весь день — ждём итераций.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import * as fs from "fs";
import * as os from "os";
import {
  CpAmm,
  getSqrtPriceFromPrice,
  getBaseFeeParams,
  getDynamicFeeParams,
  BaseFeeMode,
  CollectFeeMode,
  ActivationType,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from "@meteora-ag/cp-amm-sdk";

const GOVERNANCE_MINT = new PublicKey("BBQu1FSaMb5WZxHierR5ocs6EwMMzhcKbWGZFhaTMR3k");

async function main() {
  const connection = new Connection(
    process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com", "confirmed"
  );
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8")))
  );

  const cpAmm = new CpAmm(connection);

  // Начальная цена: условно 1 наш токен = 0.000001 SOL (можно поменять)
  const tokenADecimal = 9; // наш governance-токен
  const tokenBDecimal = 9; // wSOL
  const initPrice = 0.000001;

  const tokenAAmount = new BN("10000000").mul(new BN(10).pow(new BN(tokenADecimal))); // 10,000,000 токенов
  const tokenBAmount = new BN("100000000"); // 0.1 SOL (в лампортах, decimals=9)

  const sqrtPrice = getSqrtPriceFromPrice(String(initPrice), tokenADecimal, tokenBDecimal);

  const { initSqrtPrice, liquidityDelta } = cpAmm.preparePoolCreationParams({
    tokenAAmount,
    tokenBAmount,
    minSqrtPrice: MIN_SQRT_PRICE,
    maxSqrtPrice: MAX_SQRT_PRICE,
    collectFeeMode: CollectFeeMode.BothToken,
  });

  const baseFeeParams = getBaseFeeParams(
    {
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: {
        startingFeeBps: 25, // плоские 0.25%, start==end -> без реального планировщика
        endingFeeBps: 25,
        numberOfPeriod: 0,
        totalDuration: 0,
      },
    },
    tokenBDecimal,
    ActivationType.Timestamp
  );
  const dynamicFeeParams = getDynamicFeeParams(25);
  const poolFees = {
    baseFee: baseFeeParams,
    compoundingFeeBps: 0,
    padding: 0,
    dynamicFee: dynamicFeeParams,
  };

  const positionNftMint = Keypair.generate();

  console.log("Создаём пул...");
  const { tx, pool, position } = await cpAmm.createCustomPool({
    payer: wallet.publicKey,
    creator: wallet.publicKey,
    positionNft: positionNftMint.publicKey,
    tokenAMint: GOVERNANCE_MINT,
    tokenBMint: NATIVE_MINT,
    tokenAAmount,
    tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE,
    sqrtMaxPrice: MAX_SQRT_PRICE,
    initSqrtPrice,
    liquidityDelta,
    poolFees,
    hasAlphaVault: false,
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.BothToken,
    activationPoint: null,
    tokenAProgram: TOKEN_2022_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
  } as any);

  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(wallet, positionNftMint);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(sig, "confirmed");

  console.log("✅ Пул создан, tx:", sig);
  console.log("Pool:", pool.toBase58());
  console.log("Position:", position.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
