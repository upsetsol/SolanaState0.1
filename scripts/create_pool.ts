// Creates the Meteora DAMM v2 pool that feeds the treasury and hands its position to the state.
//
//   pair:        governance coin (token A) / treasury asset (token B: wSOL by default, or USDC/USDT)
//   fee:         constant FEE_BPS (default 500 = 5%) charged on every buy and sell, taken ONLY in
//                token B (collect fee mode "only B"), so the treasury receives the asset, not our coin
//   liquidity:   the payer's tokens go in and the position is PERMANENTLY locked (can never be
//                withdrawn), the fee keeps accruing to it
//   position:    the position NFT's token account is handed to the Config PDA, so only the program
//                (claim_pool_fees) can claim the fee, and it can only land on the treasury account.
//
//   GOVERNANCE_MINT=<mint>   TREASURY_MINT=<mint> (optional, default wSOL)
//   TOKEN_AMOUNT=<whole coins>     governance coins to put into the pool
//   QUOTE_AMOUNT=<whole units>     treasury asset to put into the pool (1 = 1 SOL / 1 USDC)
//   FEE_BPS=500                    (optional)
//   POOL_OUT=./.pool.json          (optional — where the pool/position addresses are saved)
//
// Afterwards: `npx ts-node scripts/register_pool.ts` (owners_authority) links it to the state.

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, createSetAuthorityInstruction, AuthorityType } from "@solana/spl-token";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress,
} from "@meteora-ag/cp-amm-sdk";
import * as fs from "fs";
import { parseUnits, getProvider, GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, TOKEN_PROGRAM, configPda, meteoraPositionPda, meteoraPositionNftAccountPda } from "./lib/env";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const payer: Keypair = (provider.wallet as any).payer;
  const feeBps = Number(process.env.FEE_BPS ?? "500");
  if (!process.env.TOKEN_AMOUNT || !process.env.QUOTE_AMOUNT) throw new Error("Set TOKEN_AMOUNT and QUOTE_AMOUNT (whole units).");

  const govMint = await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  const quoteMint = await getMint(conn, TREASURY_MINT, "confirmed", TREASURY_PROGRAM);
  const tokenAAmount = new BN(parseUnits(process.env.TOKEN_AMOUNT, govMint.decimals).toString());
  const tokenBAmount = new BN(parseUnits(process.env.QUOTE_AMOUNT, quoteMint.decimals).toString());

  const cpAmm = new CpAmm(conn);
  const tokenAMint = GOVERNANCE_MINT, tokenBMint = TREASURY_MINT;
  const poolAddr = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);
  if (await cpAmm.isPoolExist(poolAddr)) throw new Error("pool already exists: " + poolAddr.toBase58());

  const prep = cpAmm.preparePoolCreationParams({
    tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.OnlyB,
  } as any);
  const poolFees = {
    baseFee: getBaseFeeParams({
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
    }),
    compoundingFeeBps: 0, padding: 0, dynamicFee: null,
  };
  const positionNft = Keypair.generate();
  const { tx, pool } = await cpAmm.createCustomPool({
    payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
    tokenAMint, tokenBMint, tokenAAmount, tokenBAmount,
    sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
    poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB,
    activationPoint: null, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TREASURY_PROGRAM,
    isLockLiquidity: true,
  } as any);
  console.log(`Creating pool: ${process.env.TOKEN_AMOUNT} coins + ${process.env.QUOTE_AMOUNT} of the quote asset, fee ${feeBps / 100}% (only in token B), liquidity locked forever`);
  const sig1 = await provider.sendAndConfirm(tx, [positionNft]);
  console.log("pool created:", pool.toBase58(), "tx", sig1);

  // hand the position NFT to the Config PDA
  const nftAccount = meteoraPositionNftAccountPda(positionNft.publicKey);
  const sig2 = await provider.sendAndConfirm(
    new Transaction().add(createSetAuthorityInstruction(nftAccount, payer.publicKey, AuthorityType.AccountOwner, configPda(), [], TOKEN_2022_PROGRAM_ID))
  );
  console.log("position NFT account now owned by the Config PDA", configPda().toBase58(), "tx", sig2);

  const out = process.env.POOL_OUT ?? "./.pool.json";
  fs.writeFileSync(out, JSON.stringify({ pool: pool.toBase58(), positionNft: positionNft.publicKey.toBase58(), position: meteoraPositionPda(positionNft.publicKey).toBase58() }, null, 2));
  console.log("saved", out, "\nNext:  npx ts-node scripts/register_pool.ts   (signer = owners_authority)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
