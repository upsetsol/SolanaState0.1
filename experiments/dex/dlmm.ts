// DLMM experiment: create a pool for our Token-2022 (5% tax) token vs wSOL, add liquidity, sell, buy.
// The point is to find out whether DLMM accepts a transfer-fee token permissionlessly (no token badge).
import { PublicKey, Keypair } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
import DLMM, { LBCLMM_PROGRAM_IDS, deriveCustomizablePermissionlessLbPair, ActivationType, StrategyType } from "@meteora-ag/dlmm";
import { connection, payer, getOrCreateMint, send, tokenBalance, withheldOn, ui, DEC } from "./common";

const OPT: any = { cluster: "devnet" };

async function main() {
  const ours = await getOrCreateMint();
  const programId = new PublicKey(String((LBCLMM_PROGRAM_IDS as any)["devnet"]));
  console.log("payer:", payer.publicKey.toBase58(), "| test token:", ours.toBase58(), "| DLMM program:", programId.toBase58());

  const oursIsX = Buffer.compare(ours.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
  const tokenX = oursIsX ? ours : NATIVE_MINT;
  const tokenY = oursIsX ? NATIVE_MINT : ours;
  const decX = oursIsX ? DEC : 9, decY = oursIsX ? 9 : DEC;
  console.log("our token is side", oursIsX ? "X" : "Y");

  const [pool] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, programId);
  let exists = true;
  try { await DLMM.create(connection, pool, OPT); } catch { exists = false; }

  if (!exists) {
    const binStep = 25; // 0.25% per bin
    const solPerToken = 0.1 / 5_000_000; // 0.1 SOL for 5M tokens
    const priceYperX = oursIsX ? solPerToken : 1 / solPerToken;
    const pricePerLamport = DLMM.getPricePerLamport(decX, decY, priceYperX);
    const activeId = DLMM.getBinIdFromPrice(pricePerLamport, binStep, true);
    console.log("creating DLMM pool: binStep", binStep, "activeId", activeId, "fee 1%");
    const tx = await DLMM.createCustomizablePermissionlessLbPair2(
      connection, new BN(binStep), tokenX, tokenY, new BN(activeId), new BN(100),
      ActivationType.Timestamp, false, payer.publicKey, undefined, false, undefined, undefined, OPT
    );
    const sig = await send(tx as any, [payer]);
    console.log("POOL CREATED:", pool.toBase58(), "tx", sig);
  } else {
    console.log("pool already exists:", pool.toBase58());
  }

  const dlmm = await DLMM.create(connection, pool, OPT);
  const active = await dlmm.getActiveBin();

  // ---- add liquidity around the active bin (the deposit itself is taxed 5%) ----
  const tokens = new BN(5_000_000).mul(new BN(10).pow(new BN(DEC)));
  const sol = new BN(100_000_000);
  const positionKp = Keypair.generate();
  const addTx: any = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKp.publicKey,
    totalXAmount: oursIsX ? tokens : sol,
    totalYAmount: oursIsX ? sol : tokens,
    strategy: { minBinId: active.binId - 10, maxBinId: active.binId + 10, strategyType: StrategyType.Spot },
    user: payer.publicKey, slippage: 5,
  });
  const addTxs = Array.isArray(addTx) ? addTx : [addTx];
  for (const t of addTxs) await send(t, [payer, positionKp]);
  console.log("LIQUIDITY ADDED (21 bins, Spot)");

  await dlmm.refetchStates();
  const reserveOurs: PublicKey = oursIsX ? dlmm.lbPair.reserveX : dlmm.lbPair.reserveY;
  console.log(`tax withheld on the pool reserve after the deposit: ${ui(await withheldOn(reserveOurs))} tokens`);

  // ---- SELL 200,000 tokens ----
  const sellAmt = new BN(200_000).mul(new BN(10).pow(new BN(DEC)));
  const sellForY = oursIsX; // X -> Y when our token is X
  let binArrays = await dlmm.getBinArrayForSwap(sellForY);
  const sq = dlmm.swapQuote(sellAmt, sellForY, new BN(500), binArrays);
  console.log("SELL quote: out", sq.outAmount.toString(), "min", sq.minOutAmount.toString());
  const sellTx: any = await dlmm.swap({
    inToken: ours, outToken: NATIVE_MINT, inAmount: sellAmt, minOutAmount: new BN(0),
    lbPair: dlmm.pubkey, user: payer.publicKey, binArraysPubkey: sq.binArraysPubkey,
  });
  const beforeSell = await tokenBalance(payer.publicKey, ours);
  await send(sellTx, [payer]);
  console.log(`SELL done. my token balance change: ${ui((await tokenBalance(payer.publicKey, ours)) - beforeSell)} (sent ${ui(sellAmt.toString())})`);
  await dlmm.refetchStates();
  console.log(`  tax withheld on pool reserve now: ${ui(await withheldOn(reserveOurs))}`);

  // ---- BUY with 0.01 SOL ----
  const buyIn = new BN(10_000_000);
  const buyForY = !oursIsX;
  binArrays = await dlmm.getBinArrayForSwap(buyForY);
  const bq = dlmm.swapQuote(buyIn, buyForY, new BN(500), binArrays);
  const buyTx: any = await dlmm.swap({
    inToken: NATIVE_MINT, outToken: ours, inAmount: buyIn, minOutAmount: new BN(0),
    lbPair: dlmm.pubkey, user: payer.publicKey, binArraysPubkey: bq.binArraysPubkey,
  });
  const tokBefore = await tokenBalance(payer.publicKey, ours);
  await send(buyTx, [payer]);
  console.log(`BUY done. received ${ui((await tokenBalance(payer.publicKey, ours)) - tokBefore)} tokens for 0.01 SOL (net of the 5% tax)`);
  console.log("\nDLMM RESULT: Token-2022 with 5% transfer fee WORKS in a DLMM pool (create, add liquidity, sell, buy) without a token badge.");
}
main().catch((e) => { console.error("DLMM FAILED:", e?.message ?? e); if (e?.logs) console.error(e.logs.join("\n")); process.exit(1); });
