// Experiment: "pool fee instead of token tax". A plain SPL token (no transfer tax) paired with wSOL in a
// DAMM v2 pool whose ONLY fee is a constant 5% collected in the quote token (SOL). Devnet only.
// Questions answered by this script:
//   1. Is a constant 5% fee accepted, and is it charged in SOL in BOTH directions (OnlyB mode)?
//   2. Which share of that fee goes to the LP (us) and which to Meteora (protocol fee)?
//   3. Can a stranger add liquidity to our pool and take a share of the fee?
//   4. Can the pool creator change the fee afterwards (updatePoolFees)?
//   5. Can the fee be claimed to an arbitrary receiver (treasury) and does a permanent lock keep it claimable?
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAssociatedTokenAddressSync,
  createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction, getAccount,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress, derivePositionAddress, derivePositionNftAccount, getUnClaimLpFee, deriveOperatorAddress,
} from "@meteora-ag/cp-amm-sdk";
import * as fs from "fs";
import { connection, payer, send } from "./common";

const DEC = 9;
const FEE_BPS = 500; // 5%
const STATE_FILE = ".fee5-state.json"; // gitignored: keypair of the throw-away token + pool address
const sol = (x: BN | bigint | number | string) => (Number(x.toString()) / 1e9).toFixed(6);
const tok = (x: BN | bigint | number | string) => (Number(x.toString()) / 10 ** DEC).toLocaleString("en-US");

async function main() {
  const cpAmm = new CpAmm(connection);
  console.log("payer:", payer.publicKey.toBase58(), "| balance", sol(await connection.getBalance(payer.publicKey)), "SOL");

  // ---------- 1. plain SPL token, quote = wSOL ----------
  let mintKp: Keypair;
  if (fs.existsSync(STATE_FILE)) mintKp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).mint));
  else {
    mintKp = Keypair.generate();
    await createMint(connection, payer, payer.publicKey, null, DEC, mintKp, undefined, TOKEN_PROGRAM_ID);
    const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mintKp.publicKey, payer.publicKey);
    await mintTo(connection, payer, mintKp.publicKey, ata.address, payer, 1_000_000_000n * 10n ** BigInt(DEC));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mint: Array.from(mintKp.secretKey) }));
    console.log("created plain SPL test token (NO transfer tax):", mintKp.publicKey.toBase58());
  }
  const ours = mintKp.publicKey;
  // token A = ours, token B = wSOL (quote). OnlyB => fees are always taken in token B = SOL.
  const tokenAMint = ours, tokenBMint = NATIVE_MINT;
  console.log("mint order: ours < wSOL ?", Buffer.compare(ours.toBuffer(), NATIVE_MINT.toBuffer()) < 0, "(we pass ours as A, wSOL as B regardless)");
  const poolAddr = deriveCustomizablePoolAddress(tokenAMint, tokenBMint);

  let exists = true;
  try { await cpAmm.fetchPoolState(poolAddr); } catch { exists = false; }
  const positionNft = Keypair.generate();
  if (!exists) {
    const tokenAAmount = new BN(10_000_000).mul(new BN(10).pow(new BN(DEC)));
    const tokenBAmount = new BN(200_000_000); // 0.2 SOL
    const prep = cpAmm.preparePoolCreationParams({
      tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE,
      collectFeeMode: CollectFeeMode.OnlyB,
    } as any);
    const poolFees = {
      baseFee: getBaseFeeParams(
        { baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: FEE_BPS, endingFeeBps: FEE_BPS, numberOfPeriod: 0, totalDuration: 0 } }),
      compoundingFeeBps: 0, padding: 0, dynamicFee: null,
    };
    console.log(`creating pool: 10M tokens + 0.2 SOL, constant ${FEE_BPS / 100}% fee, collectFeeMode=OnlyB (SOL only) ...`);
    const { tx, pool } = await cpAmm.createCustomPool({
      payer: payer.publicKey, creator: payer.publicKey, positionNft: positionNft.publicKey,
      tokenAMint, tokenBMint, tokenAAmount, tokenBAmount,
      sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
      poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB,
      activationPoint: null, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    } as any);
    const sig = await send(tx, [payer, positionNft]);
    fs.writeFileSync(STATE_FILE, JSON.stringify({ mint: Array.from(mintKp.secretKey), pool: pool.toBase58(), positionNft: Array.from(positionNft.secretKey) }));
    console.log("[Q1] POOL CREATED with constant 5% fee, SOL-only collection:", pool.toBase58(), sig);
  } else {
    console.log("pool exists:", poolAddr.toBase58());
  }
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const myNft = Keypair.fromSecretKey(Uint8Array.from(saved.positionNft));
  const myPosition = derivePositionAddress(myNft.publicKey);
  const myNftAccount = derivePositionNftAccount(myNft.publicKey);

  const fees = await cpAmm.fetchPoolFees(poolAddr);
  let st: any = await cpAmm.fetchPoolState(poolAddr);
  console.log("pool collectFeeMode:", st.collectFeeMode, "(1 = OnlyB) | decoded base fee:", JSON.stringify(fees, (_k, v) => (v && v.toString && v.constructor?.name === "BN" ? v.toString() : v)).slice(0, 300));

  // ---------- 2. sell (A->B) and buy (B->A): fee must be in SOL both times ----------
  const swap = async (inMint: PublicKey, outMint: PublicKey, amountIn: BN, who: Keypair = payer) => {
    st = await cpAmm.fetchPoolState(poolAddr);
    const tx = await cpAmm.swap({
      payer: who.publicKey, pool: poolAddr, inputTokenMint: inMint, outputTokenMint: outMint, amountIn, minimumAmountOut: new BN(0),
      tokenAMint, tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, poolState: st,
    } as any);
    return send(tx, [who]);
  };
  const unclaimed = async (pos: PublicKey) => {
    const ps = await cpAmm.fetchPositionState(pos);
    const s: any = await cpAmm.fetchPoolState(poolAddr);
    const r: any = getUnClaimLpFee(s, ps);
    return { a: new BN(r.feeTokenA ?? r.feeA ?? 0), b: new BN(r.feeTokenB ?? r.feeB ?? 0), raw: r };
  };
  const b0 = await unclaimed(myPosition);
  console.log("unclaimed fees before trades: A", tok(b0.a), "B(SOL)", sol(b0.b));

  const sellAmt = new BN(1_000_000).mul(new BN(10).pow(new BN(DEC)));
  const solBeforeSell = await connection.getBalance(payer.publicKey);
  await swap(tokenAMint, tokenBMint, sellAmt);
  const b1 = await unclaimed(myPosition);
  console.log(`[Q1/Q2] SELL 1,000,000 tokens -> unclaimed fee A=${tok(b1.a.sub(b0.a))} tokens, B=${sol(b1.b.sub(b0.b))} SOL (fee must be only in B)`);

  const buyAmt = new BN(50_000_000); // 0.05 SOL
  await swap(tokenBMint, tokenAMint, buyAmt);
  const b2 = await unclaimed(myPosition);
  const feeFromBuy = b2.b.sub(b1.b);
  console.log(`[Q1/Q2] BUY with 0.05 SOL -> unclaimed fee A=${tok(b2.a.sub(b1.a))} tokens, B=${sol(feeFromBuy)} SOL`);
  console.log(`   5% of 0.05 SOL = ${sol(buyAmt.muln(5).divn(100))} SOL total trading fee; LP (us) got ${sol(feeFromBuy)} SOL of it`);
  st = await cpAmm.fetchPoolState(poolAddr);
  console.log("   pool protocol fee counters: protocolAFee", tok(st.protocolAFee), "protocolBFee(SOL)", sol(st.protocolBFee));

  // ---------- 3. a stranger adds liquidity: does he share our fee? ----------
  const stranger = Keypair.generate();
  const fundTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: stranger.publicKey, lamports: 120_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, getAssociatedTokenAddressSync(ours, stranger.publicKey), stranger.publicKey, ours),
    createTransferInstruction(getAssociatedTokenAddressSync(ours, payer.publicKey), getAssociatedTokenAddressSync(ours, stranger.publicKey), payer.publicKey, 3_000_000n * 10n ** BigInt(DEC)),
  );
  await send(fundTx, [payer]);
  st = await cpAmm.fetchPoolState(poolAddr);
  const strangerNft = Keypair.generate();
  const inA = new BN(2_000_000).mul(new BN(10).pow(new BN(DEC))); // he deposits 2M tokens (+ matching SOL)
  const dq: any = cpAmm.getDepositQuote({
    inAmount: inA, isTokenA: true, minSqrtPrice: st.sqrtMinPrice, maxSqrtPrice: st.sqrtMaxPrice, sqrtPrice: st.sqrtPrice,
    collectFeeMode: CollectFeeMode.OnlyB, tokenAAmount: st.tokenAAmount, tokenBAmount: st.tokenBAmount, liquidity: st.liquidity,
  } as any);
  const liqDelta: BN = dq.liquidityDelta;
  console.log("stranger deposit quote: tokens", tok(dq.consumedInputAmount), "-> SOL needed", sol(dq.outputAmount), "| liquidity share ~", (Number(liqDelta.toString()) / (Number(st.liquidity.toString()) + Number(liqDelta.toString())) * 100).toFixed(1) + "%");
  let strangerJoined = false;
  try {
    const tx = await cpAmm.createPositionAndAddLiquidity({
      owner: stranger.publicKey, pool: poolAddr, positionNft: strangerNft.publicKey, liquidityDelta: liqDelta,
      maxAmountTokenA: inA.muln(11).divn(10), maxAmountTokenB: dq.outputAmount.muln(11).divn(10).addn(1000),
      tokenAAmountThreshold: inA.muln(11).divn(10), tokenBAmountThreshold: dq.outputAmount.muln(11).divn(10).addn(1000),
      tokenAMint, tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    } as any);
    await send(tx, [stranger, strangerNft]);
    strangerJoined = true;
    console.log("[Q3] STRANGER ADDED LIQUIDITY to our pool WITHOUT any permission: yes");
  } catch (e: any) {
    console.log("[Q3] stranger could NOT add liquidity:", String(e?.message).slice(0, 300));
  }
  if (strangerJoined) {
    const beforeMine = await unclaimed(myPosition);
    const strangerPos = derivePositionAddress(strangerNft.publicKey);
    const beforeStranger = await unclaimed(strangerPos);
    await swap(tokenBMint, tokenAMint, new BN(30_000_000)); // 0.03 SOL trade after he joined
    const afterMine = await unclaimed(myPosition);
    const afterStranger = await unclaimed(strangerPos);
    const mineGain = afterMine.b.sub(beforeMine.b), strGain = afterStranger.b.sub(beforeStranger.b);
    const total = mineGain.add(strGain);
    console.log(`[Q3] fee of one 0.03 SOL trade after the stranger joined: ours ${sol(mineGain)} SOL, stranger ${sol(strGain)} SOL => stranger share ${(Number(strGain.toString()) / Number(total.toString()) * 100).toFixed(1)}%`);
  }

  // ---------- 4. can the creator change the fee? ----------
  try {
    const ix = await (cpAmm as any)._program.methods
      .updatePoolFees({ cliffFeeNumerator: new BN(1), baseFeeMode: null, baseFeeParams: null, dynamicFee: null, compoundingFeeBps: null })
      .accountsPartial({ pool: poolAddr, operator: deriveOperatorAddress(payer.publicKey), signer: payer.publicKey })
      .instruction();
    await send(new Transaction().add(ix), [payer]);
    console.log("[Q4] !!! creator CHANGED the pool fee (unexpected)");
  } catch (e: any) {
    console.log("[Q4] creator cannot change the fee via updatePoolFees. Error:", String(e?.message).slice(0, 220));
    if (e?.logs) console.log("    logs:", e.logs.slice(-4).join(" | ").slice(0, 400));
  }

  // ---------- 5. claim straight into token accounts of another owner (stands for the treasury PDA) ----------
  const treasury = Keypair.generate().publicKey;
  const treasurySol = getAssociatedTokenAddressSync(NATIVE_MINT, treasury, true);
  const treasuryTok = getAssociatedTokenAddressSync(ours, treasury, true);
  st = await cpAmm.fetchPoolState(poolAddr);
  const claimIx = await (cpAmm as any).buildClaimPositionFeeInstruction({
    owner: payer.publicKey, poolAuthority: (cpAmm as any).poolAuthority, pool: poolAddr, position: myPosition, positionNftAccount: myNftAccount,
    tokenAAccount: treasuryTok, tokenBAccount: treasurySol, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
    tokenAMint, tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  });
  const claimTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasuryTok, treasury, ours),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, treasurySol, treasury, NATIVE_MINT),
    claimIx,
  );
  const pending = await unclaimed(myPosition);
  await send(claimTx, [payer]);
  const got = await getAccount(connection, treasurySol);
  const gotTok = await getAccount(connection, treasuryTok);
  console.log(`[Q5] claimed fees straight into the treasury-owned accounts: wSOL ${sol(got.amount)} (pending was ${sol(pending.b)}), our token ${tok(gotTok.amount)}; signer was the position owner only`);

  // ---------- 6. permanent lock of our liquidity: fees must stay claimable, liquidity must not be withdrawable ----------
  const ps = await cpAmm.fetchPositionState(myPosition);
  if (!cpAmm.isPermanentLockedPosition(ps)) {
    const lockTx = await cpAmm.permanentLockPosition({
      owner: payer.publicKey, position: myPosition, positionNftAccount: myNftAccount, pool: poolAddr, unlockedLiquidity: ps.unlockedLiquidity,
    } as any);
    await send(lockTx, [payer]);
    console.log("[Q6] our position is now PERMANENTLY locked (liquidity can never be withdrawn)");
  }
  await swap(tokenBMint, tokenAMint, new BN(20_000_000));
  const afterLock = await unclaimed(myPosition);
  console.log(`[Q6] after the lock and one more trade, unclaimed fee still accrues: ${sol(afterLock.b)} SOL`);
  const claimIx2 = await (cpAmm as any).buildClaimPositionFeeInstruction({
    owner: payer.publicKey, poolAuthority: (cpAmm as any).poolAuthority, pool: poolAddr, position: myPosition, positionNftAccount: myNftAccount,
    tokenAAccount: treasuryTok, tokenBAccount: treasurySol, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
    tokenAMint, tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  });
  await send(new Transaction().add(claimIx2), [payer]);
  console.log(`[Q6] claim after the permanent lock works; treasury wSOL now ${sol((await getAccount(connection, treasurySol)).amount)}`);
  try {
    const rm = await cpAmm.removeAllLiquidity({
      owner: payer.publicKey, pool: poolAddr, position: myPosition, positionNftAccount: myNftAccount,
      tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), tokenAMint, tokenBMint,
      tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, vestings: [], currentPoint: new BN(0),
    } as any);
    await send(rm, [payer]);
    console.log("[Q6] !!! removing locked liquidity SUCCEEDED (unexpected)");
  } catch (e: any) {
    console.log("[Q6] withdrawing the locked liquidity is rejected (as intended):", String(e?.message).split("\n")[0].slice(0, 120));
  }
  console.log("done");
}
main().catch((e) => { console.error("FAILED:", e?.stack ?? e?.message ?? e); if (e?.logs) console.error(e.logs.join("\n")); process.exit(1); });
