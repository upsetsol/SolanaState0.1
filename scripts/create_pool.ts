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
// ONE-SIDED LAUNCH ("the dev holds 0 coins"): the whole supply goes into the pool as coins only, no SOL at all.
//   SINGLE_SIDED=1                 turn it on (QUOTE_AMOUNT is not used)
//   TOKEN_AMOUNT=all               put EVERY coin the payer holds into the pool (or a whole-coin number)
//   START_FDV=<SOL>                what the WHOLE supply is worth at the start, in the treasury asset (e.g. 30). The first coin costs START_FDV / supply.
//   END_MULT=10000                 (optional) the price range ends END_MULT times above the start; if every coin gets bought the price cannot go higher.
//   START_IN_SECS=<seconds>        (optional) trading opens this many seconds after the pool is created (default: at once)
// The price range is fixed forever when the pool is created (the liquidity is locked) — choose START_FDV with the owner.
//
// Run it BEFORE handing coins to other people: the pool address depends only on the token pair, so
// whoever holds coins could create the pair's pool first and block yours.
// Afterwards: `npx ts-node scripts/register_pool.ts` (owners_authority) links it to the state.

import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint, getAccount, getAssociatedTokenAddressSync, createSetAuthorityInstruction, AuthorityType } from "@solana/spl-token";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress,
} from "@meteora-ag/cp-amm-sdk";
import * as fs from "fs";
import { parseUnits, getProvider, GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, TOKEN_PROGRAM, configPda, meteoraPositionPda, meteoraPositionNftAccountPda } from "./lib/env";

/** sqrt(price) as a Q64.64 number (price = raw quote units per raw coin unit), exact integer square root. */
function sqrtQ64(price: number): BN {
  const scaled = BigInt(Math.round(price * 1e18)); // price * 1e18
  let x = BigInt(Math.floor(Math.sqrt(price) * 2 ** 64)) || 1n; // start near the answer
  const target = (scaled << 128n) / 10n ** 18n;
  for (let i = 0; i < 200; i++) { const y = (x + target / x) >> 1n; if (y === x || y === x + 1n || y + 1n === x) { x = y; break; } x = y; }
  return new BN(x.toString());
}

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const payer: Keypair = (provider.wallet as any).payer;
  const feeBps = Number(process.env.FEE_BPS ?? "500");
  const single = process.env.SINGLE_SIDED === "1";
  if (!process.env.TOKEN_AMOUNT || (!single && !process.env.QUOTE_AMOUNT)) throw new Error("Set TOKEN_AMOUNT and QUOTE_AMOUNT (whole units), or SINGLE_SIDED=1 with TOKEN_AMOUNT and START_FDV.");
  if (single && !process.env.START_FDV) throw new Error("SINGLE_SIDED=1 needs START_FDV (what the whole supply is worth at the start, in the treasury asset).");

  const govMint = await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  const quoteMint = await getMint(conn, TREASURY_MINT, "confirmed", TREASURY_PROGRAM);
  let tokenAAmount: BN;
  if (process.env.TOKEN_AMOUNT === "all") {
    const mine = getAssociatedTokenAddressSync(GOVERNANCE_MINT, payer.publicKey, false, TOKEN_PROGRAM);
    tokenAAmount = new BN((await getAccount(conn, mine, "confirmed", TOKEN_PROGRAM)).amount.toString());
  } else tokenAAmount = new BN(parseUnits(process.env.TOKEN_AMOUNT, govMint.decimals).toString());
  const tokenBAmount = single ? new BN(0) : new BN(parseUnits(process.env.QUOTE_AMOUNT!, quoteMint.decimals).toString());

  const cpAmm = new CpAmm(conn);
  const tokenAMint = GOVERNANCE_MINT, tokenBMint = TREASURY_MINT;
  const poolAddr = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);
  if (await cpAmm.isPoolExist(poolAddr)) throw new Error("pool already exists: " + poolAddr.toBase58());

  // price range: two-sided = the whole range with the price implied by the two amounts; one-sided = [start, start * END_MULT]
  let sqrtMin = MIN_SQRT_PRICE, sqrtMax = MAX_SQRT_PRICE, initSqrt: BN, liquidityDelta: BN;
  if (single) {
    const supplyCoins = Number(govMint.supply) / 10 ** govMint.decimals;
    const startPrice = Number(process.env.START_FDV) / supplyCoins; // treasury asset per coin
    const endMult = Number(process.env.END_MULT ?? "10000");
    const rawFactor = 10 ** (quoteMint.decimals - govMint.decimals); // raw B units per raw A unit
    sqrtMin = sqrtQ64(startPrice * rawFactor); sqrtMax = sqrtQ64(startPrice * endMult * rawFactor);
    if (sqrtMin.lte(MIN_SQRT_PRICE) || sqrtMax.gt(MAX_SQRT_PRICE) || sqrtMin.gte(sqrtMax)) throw new Error("price range outside what the pool supports");
    initSqrt = sqrtMin;
    liquidityDelta = cpAmm.preparePoolCreationSingleSide({ tokenAAmount, minSqrtPrice: sqrtMin, maxSqrtPrice: sqrtMax, initSqrtPrice: initSqrt, collectFeeMode: CollectFeeMode.OnlyB } as any);
    const needB = liquidityDelta.mul(sqrtMax.sub(sqrtMin)).shrn(128); // quote asset buyers must pay in to take EVERY coin
    console.log(`one-sided launch: ${Number(tokenAAmount.toString()) / 10 ** govMint.decimals} coins, nothing else goes in`);
    console.log(`  start price ${startPrice.toExponential(3)} per coin  -> the whole supply is worth ${process.env.START_FDV} at the start`);
    console.log(`  range ends ${endMult}x higher (${(startPrice * endMult).toExponential(3)} per coin); taking EVERY coin out of the pool would cost buyers about ${(Number(needB.toString()) / 10 ** quoteMint.decimals).toFixed(2)} in total`);
  } else {
    const prep = cpAmm.preparePoolCreationParams({
      tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.OnlyB,
    } as any);
    initSqrt = prep.initSqrtPrice; liquidityDelta = prep.liquidityDelta;
  }
  const poolFees = {
    baseFee: getBaseFeeParams({
      baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear,
      feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
    }),
    compoundingFeeBps: 0, padding: 0, dynamicFee: null,
  };
  let activationPoint: BN | null = null;
  if (process.env.START_IN_SECS) {
    const slot = await conn.getSlot();
    const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    activationPoint = new BN(now + Number(process.env.START_IN_SECS));
    console.log(`trading opens at unix time ${activationPoint.toString()} (in ${process.env.START_IN_SECS} s)`);
  }
  const positionNft = Keypair.generate();
  const { tx, pool } = await cpAmm.createCustomPool({
    payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
    tokenAMint, tokenBMint, tokenAAmount, tokenBAmount,
    sqrtMinPrice: sqrtMin, sqrtMaxPrice: sqrtMax, initSqrtPrice: initSqrt, liquidityDelta,
    poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB,
    activationPoint, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TREASURY_PROGRAM,
    isLockLiquidity: true,
  } as any);
  console.log(`Creating pool: ${single ? "ALL coins, no quote asset (one-sided)" : process.env.TOKEN_AMOUNT + " coins + " + process.env.QUOTE_AMOUNT + " of the quote asset"}, fee ${feeBps / 100}% (only in token B), liquidity locked forever`);
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
