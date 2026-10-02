// "The dev holds ZERO coins": launch where the WHOLE supply sits in the Meteora pool as one-sided liquidity (coins only, no SOL),
// locked forever and owned by the state (Config PDA).  The price starts at P_min and climbs along the curve as people buy.
// Checks on the real bytecode (local validator): the pool can be created that way, register_pool accepts it, buys/sells work,
// the 5% fee is split 20% Meteora / 80% state treasury (the treasury owns 100% of the liquidity), the dev wallet really has 0 coins.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/single_sided_launch.ts
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction } from "@solana/spl-token";
import { CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, derivePositionAddress, derivePositionNftAccount, deriveCustomizablePoolAddress } from "@meteora-ag/cp-amm-sdk";
import { makeWorld, group, record, BN, NATIVE_MINT, TP, TPT, ATAP, COIN, SOL, progFor, finish, errText } from "./lib";

const sqrtQ64 = (price: number) => new BN(Math.floor(Math.sqrt(price) * 2 ** 32).toString()).shln(32); // both tokens have 9 decimals
const f = (x: bigint | number, d = 4) => (Number(x) / 1e9).toFixed(d);

async function main() {
  group("Single-sided launch (dev holds 0)");
  const P_MIN = 1e-8, P_MAX = 1e-6; // SOL per coin: 1B coins -> start FDV 10 SOL, end FDV 1000 SOL
  const w = await makeWorld({ name: "ss", supplyCoins: 1_000_000_000n });
  const cp: CpAmm = w.cpAmm;
  const sqrtMin = sqrtQ64(P_MIN), sqrtMax = sqrtQ64(P_MAX);
  const allCoins = new BN((await w.bal(w.myAta)).toString()); // EVERYTHING the dev holds
  const liquidityDelta = cp.preparePoolCreationSingleSide({ tokenAAmount: allCoins, minSqrtPrice: sqrtMin, maxSqrtPrice: sqrtMax, initSqrtPrice: sqrtMin, collectFeeMode: CollectFeeMode.OnlyB } as any);
  const positionNft = Keypair.generate();
  const poolFees = {
    baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 500, endingFeeBps: 500, numberOfPeriod: 0, totalDuration: 0 } }),
    compoundingFeeBps: 0, padding: 0, dynamicFee: null,
  };
  let created = false, err = "";
  try {
    const { tx } = await cp.createCustomPool({
      payer: w.me, creator: w.me, positionNft: positionNft.publicKey, tokenAMint: w.mint.publicKey, tokenBMint: NATIVE_MINT,
      tokenAAmount: allCoins, tokenBAmount: new BN(0), sqrtMinPrice: sqrtMin, sqrtMaxPrice: sqrtMax, initSqrtPrice: sqrtMin, liquidityDelta,
      poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB, activationPoint: null,
      tokenAProgram: TP, tokenBProgram: TPT, isLockLiquidity: true,
    } as any);
    await w.provider.sendAndConfirm(tx, [positionNft]);
    created = true;
  } catch (e) { err = errText(e).slice(0, 300); }
  record("SS.1", "create a pool with the WHOLE supply as one-sided liquidity (no SOL), locked forever", created ? "OK" : "ERROR", created ? `1,000,000,000 coins in, price range ${P_MIN}..${P_MAX} SOL/coin` : err);
  if (!created) return finish("audit/results_single_sided.json");

  const position = derivePositionAddress(positionNft.publicKey), nftAccount = derivePositionNftAccount(positionNft.publicKey);
  await w.provider.sendAndConfirm(new Transaction().add(createSetAuthorityInstruction(nftAccount, w.me, AuthorityType.AccountOwner, w.configPda, [], TP)));
  let registered = false; err = "";
  try {
    await w.program.methods.registerPool().accounts({
      owner: w.me, config: w.configPda, governanceMint: w.mint.publicKey, pool: deriveCustomizablePoolAddress(w.mint.publicKey, NATIVE_MINT), position, positionNftAccount: nftAccount,
      feeAAccount: w.feeAAccount, governanceTokenProgram: TP, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
    }).rpc();
    registered = true;
  } catch (e) { err = errText(e).slice(0, 300); }
  record("SS.2", "register_pool accepts the one-sided pool", registered ? "OK" : "ERROR", registered ? "state now owns the locked position" : err);
  if (!registered) return finish("audit/results_single_sided.json");

  const dev = await w.bal(w.myAta);
  record("SS.3", "the dev wallet's coins after the launch", dev === 0n ? "OK" : "ERROR", `dev holds ${Number(dev / COIN)} coins; pool vault holds ${Number((await w.bal(await w.poolVaultA())) / COIN).toLocaleString("en")} coins; SOL in pool ${f(await w.tbal(await w.poolVaultB()))}`);

  // trades
  const buyer = await w.holder(0n, 500);
  const price = async () => { const s: any = await cp.fetchPoolState(w.poolAddr); return (Number(s.sqrtPrice.toString()) / 2 ** 64) ** 2; };
  const steps: string[] = [];
  let volume = 0n;
  for (const amt of [SOL / 10n, 2n * SOL, 20n * SOL]) {
    const c0 = await w.bal(w.ata(buyer.publicKey));
    try { await w.swap(buyer, "buy", amt); volume += amt; } catch (e) { steps.push(`buy ${f(amt, 2)} SOL FAILED: ${errText(e).slice(0, 120)}`); continue; }
    const got = (await w.bal(w.ata(buyer.publicKey))) - c0;
    steps.push(`buy ${f(amt, 2)} SOL -> ${Number(got / COIN).toLocaleString("en")} coins, price now ${(await price()).toExponential(2)} SOL/coin`);
  }
  record("SS.4", "buys along the curve", "INFO", steps.join(" | "));
  const held = await w.bal(w.ata(buyer.publicKey));
  await w.ensureT(buyer.publicKey);
  const sellBefore = await w.solOf(buyer.publicKey);
  await w.swap(buyer, "sell", held / COIN / 2n);
  record("SS.5", "a sell of half of the bought coins works (the buyer can exit)", "OK", `price after the sell ${(await price()).toExponential(2)} SOL/coin`);

  const sellProceeds = (await w.solOf(buyer.publicKey)) - sellBefore;
  const t0 = await w.tbal(w.treasury);
  await progFor(buyer).methods.claimPoolFees().accounts(await w.claimFeesAccts(buyer.publicKey)).rpc();
  const claimed = (await w.tbal(w.treasury)) - t0;
  const total = volume + (sellProceeds > 0n ? sellProceeds : 0n);
  record("SS.6", "claim_pool_fees: the state treasury gets 80% of the 5% fee (it owns 100% of the liquidity)", "INFO",
    `volume: buys ${f(volume, 2)} SOL + the sell ${f(sellProceeds, 2)} SOL (after its fee); treasury received ${f(claimed)} SOL = ${(Number(claimed) / Number(total) * 100).toFixed(2)}% of the volume (expected ≈4%: 80% of 5%)`);
  const base = (await w.supplyNow()) - (await w.bal(await w.poolVaultA()));
  record("SS.7", "governance side effect: the voting base (supply minus the pool's coins) after these buys", "INFO",
    `${Number(base / COIN).toLocaleString("en")} coins = ${(Number(base) / Number(await w.supplyNow()) * 100).toFixed(2)}% of the supply — the first buyers ARE the electorate; early votes are decided by very few coins`);
  finish("audit/results_single_sided.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
