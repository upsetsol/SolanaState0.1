// DAMM v2 experiment: create a pool for our Token-2022 (5% tax) token vs wSOL, buy, sell, and
// measure how the tax interacts with the pool. Devnet only.
import { PublicKey, Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import BN from "bn.js";
import {
  CpAmm, getSqrtPriceFromPrice, getBaseFeeParams, getDynamicFeeParams, BaseFeeMode, CollectFeeMode,
  ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE, deriveCustomizablePoolAddress,
} from "@meteora-ag/cp-amm-sdk";
import { connection, payer, getOrCreateMint, send, tokenBalance, withheldOn, ui, DEC } from "./common";

async function main() {
  const ours = await getOrCreateMint();
  const cpAmm = new CpAmm(connection);
  const epoch = (await connection.getEpochInfo()).epoch;
  const ourMintInfo = await getMint(connection, ours, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("payer:", payer.publicKey.toBase58(), "| test token:", ours.toBase58());

  // The pool sorts the two mints; keep track of which side is ours.
  const oursIsA = Buffer.compare(ours.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
  const tokenAMint = oursIsA ? ours : NATIVE_MINT;
  const tokenBMint = oursIsA ? NATIVE_MINT : ours;
  const tokenAProgram = oursIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const tokenBProgram = oursIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID;
  console.log("our token is side", oursIsA ? "A" : "B");

  const poolAddr = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);
  let poolExists = true;
  try { await cpAmm.fetchPoolState(poolAddr); } catch { poolExists = false; }

  if (!poolExists) {
    const tokens = new BN(10_000_000).mul(new BN(10).pow(new BN(DEC))); // 10M tokens
    const sol = new BN(200_000_000); // 0.2 SOL
    const tokenAAmount = oursIsA ? tokens : sol;
    const tokenBAmount = oursIsA ? sol : tokens;
    const prep = cpAmm.preparePoolCreationParams({
      tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE,
      tokenAInfo: oursIsA ? { mint: ourMintInfo, currentEpoch: epoch } : undefined,
      tokenBInfo: oursIsA ? undefined : { mint: ourMintInfo, currentEpoch: epoch },
      collectFeeMode: CollectFeeMode.BothToken,
    });
    const poolFees = {
      baseFee: getBaseFeeParams(
        { baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } }),
      compoundingFeeBps: 0, padding: 0, dynamicFee: getDynamicFeeParams(25),
    };
    const positionNft = Keypair.generate();
    console.log("creating DAMM v2 pool (0.25% pool fee, 10M tokens + 0.2 SOL)...");
    const { tx, pool } = await cpAmm.createCustomPool({
      payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
      tokenAMint, tokenBMint, tokenAAmount, tokenBAmount,
      sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE,
      initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
      poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp,
      collectFeeMode: CollectFeeMode.BothToken, activationPoint: null, tokenAProgram, tokenBProgram,
    } as any);
    const sig = await send(tx, [payer, positionNft]);
    console.log("POOL CREATED:", pool.toBase58(), "tx", sig);
  } else {
    console.log("pool already exists:", poolAddr.toBase58());
  }

  const state: any = await cpAmm.fetchPoolState(poolAddr);
  const vaultOurs: PublicKey = oursIsA ? state.tokenAVault : state.tokenBVault;
  const before = { mine: await tokenBalance(payer.publicKey, ours), vaultWithheld: await withheldOn(vaultOurs) };
  console.log(`vault withheld tax right after pool creation (deposit was taxed): ${ui(before.vaultWithheld)} tokens`);

  // ---- SELL: 1,000,000 tokens -> SOL ----
  const sellAmt = new BN(1_000_000).mul(new BN(10).pow(new BN(DEC)));
  const slot = await connection.getSlot();
  const now = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const q = cpAmm.getQuote({
    inAmount: sellAmt, inputTokenMint: ours, slippage: 5, poolState: state, currentTime: now, currentSlot: slot,
    inputTokenInfo: { mint: ourMintInfo, currentEpoch: epoch }, tokenADecimal: oursIsA ? DEC : 9, tokenBDecimal: oursIsA ? 9 : DEC,
  } as any);
  console.log("SELL quote: in", ui(sellAmt.toString()), "tokens -> out (SOL lamports)", q.swapOutAmount?.toString?.() ?? JSON.stringify(q).slice(0, 200));
  const sellTx = await cpAmm.swap({
    payer: payer.publicKey, pool: poolAddr, inputTokenMint: ours, outputTokenMint: NATIVE_MINT,
    amountIn: sellAmt, minimumAmountOut: new BN(0), tokenAMint, tokenBMint,
    tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram, tokenBProgram,
    referralTokenAccount: null, poolState: state,
  } as any);
  const sellSig = await send(sellTx, [payer]);
  const afterSell = { mine: await tokenBalance(payer.publicKey, ours), vaultWithheld: await withheldOn(vaultOurs) };
  console.log("SELL done", sellSig);
  console.log(`  my balance change: ${ui(afterSell.mine - before.mine)} tokens (sent ${ui(sellAmt.toString())})`);
  console.log(`  tax withheld on the pool vault after sell: ${ui(afterSell.vaultWithheld)} (5% of the sold amount expected: ${ui((BigInt(sellAmt.toString()) * 5n) / 100n)})`);

  // ---- BUY: 0.02 SOL -> tokens ----
  const state2: any = await cpAmm.fetchPoolState(poolAddr);
  const buyIn = new BN(20_000_000);
  const solBefore = await connection.getBalance(payer.publicKey);
  const tokBefore = await tokenBalance(payer.publicKey, ours);
  const buyTx = await cpAmm.swap({
    payer: payer.publicKey, pool: poolAddr, inputTokenMint: NATIVE_MINT, outputTokenMint: ours,
    amountIn: buyIn, minimumAmountOut: new BN(0), tokenAMint, tokenBMint,
    tokenAVault: state2.tokenAVault, tokenBVault: state2.tokenBVault, tokenAProgram, tokenBProgram,
    referralTokenAccount: null, poolState: state2,
  } as any);
  const buySig = await send(buyTx, [payer]);
  const tokAfter = await tokenBalance(payer.publicKey, ours);
  console.log("BUY done", buySig);
  console.log(`  spent ~0.02 SOL, received ${ui(tokAfter - tokBefore)} tokens (net of the 5% tax)`);
  console.log(`  tax now withheld on my own account (from the buy): ${ui(await withheldOn(await (async () => (await import("@solana/spl-token")).getAssociatedTokenAddressSync(ours, payer.publicKey, false, TOKEN_2022_PROGRAM_ID))()))}`);
  console.log("\nDAMM v2 RESULT: Token-2022 with 5% transfer fee WORKS in a DAMM v2 pool (create, sell, buy).");
}
main().catch((e) => { console.error("DAMM v2 FAILED:", e?.message ?? e); if (e?.logs) console.error(e.logs.join("\n")); process.exit(1); });
