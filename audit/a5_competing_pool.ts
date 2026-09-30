// A5 — the 5% fee only exists INSIDE our pool.  Anyone holding coins can open a second pool for the same pair
// from a PUBLIC Meteora config with a much lower fee (mainnet has 152 public non-compounding configs, cheapest 0.25%).
// This test really creates such a pool on the local validator (config 82p7… = public, "fee only in B", 0.25%,
// cloned from devnet/mainnet — same address on both) and compares what a trader gets and what the treasury earns.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a5_competing_pool.ts
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { CpAmm, CollectFeeMode, MIN_SQRT_PRICE, MAX_SQRT_PRICE, derivePoolAddress } from "@meteora-ag/cp-amm-sdk";
import { makeWorld, group, record, recordKnown, sendSigned, progFor, BN, NATIVE_MINT, TP, TPT, COIN, SOL, finish, errText } from "./lib";

const PUBLIC_CONFIG_ONLYB_25BPS = new PublicKey("82p7sVzQWZfCrmStPhsG8BYKwheQkUiXSs2wiqdhwNxr");

async function main() {
  group("A5 competing (cheaper) pool for the same pair");
  const w = await makeWorld({ name: "a5" });
  const C = await w.holder(300_000_000n, 400); // an ordinary holder with coins and SOL
  const T = await w.holder(0n, 300); // a trader
  await w.withPool(300_000_000n, 30n * SOL); // OUR pool: 5% fee, registered, liquidity locked

  // ---- the rival pool: public config, 0.25% fee, same depth (300M coins / 30 SOL)
  const cp: CpAmm = w.cpAmm;
  const tokenAAmount = new BN((300_000_000n * COIN).toString());
  const tokenBAmount = new BN((30n * SOL).toString());
  const prep = cp.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.OnlyB } as any);
  const nft = Keypair.generate();
  const rivalPool = derivePoolAddress(PUBLIC_CONFIG_ONLYB_25BPS, w.mint.publicKey, NATIVE_MINT);
  let created = false, err = "";
  try {
    const tx: Transaction = await (cp as any).createPool({
      creator: C.publicKey, payer: C.publicKey, config: PUBLIC_CONFIG_ONLYB_25BPS, positionNft: nft.publicKey,
      tokenAMint: w.mint.publicKey, tokenBMint: NATIVE_MINT, initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
      tokenAAmount, tokenBAmount, activationPoint: null, tokenAProgram: TP, tokenBProgram: TPT, isLockLiquidity: false,
    });
    await sendSigned(tx, [C, nft]);
    created = true;
  } catch (e) { err = errText(e).slice(0, 300); }
  recordKnown("A5.1", "an ordinary holder (no keys of ours) opens a SECOND pool for the same pair from a public Meteora config with a 0.25% fee", created, "PENDING", created ? `rival pool ${rivalPool.toBase58()} exists next to ours ${w.poolAddr.toBase58()} (an AMM property; Nikita decides whether to accept it or return to a coin-level fee)` : err);
  if (!created) { finish("audit/results_a5.json"); return; }

  // ---- what does a trader get for the same 1 SOL in each pool?
  const coinsOf = async (k: PublicKey) => (await w.bal(w.ata(k)));
  const c0 = await coinsOf(T.publicKey);
  await w.swap(T, "buy", SOL, w.poolAddr);
  const ours = (await coinsOf(T.publicKey)) - c0;
  const c1 = await coinsOf(T.publicKey);
  await w.swap(T, "buy", SOL, rivalPool);
  const rival = (await coinsOf(T.publicKey)) - c1;
  const better = (Number(rival) / Number(ours) - 1) * 100;
  recordKnown("A5.2", "same trader, same 1 SOL buy: coins received in OUR 5% pool vs the rival 0.25% pool", rival > ours, "PENDING",
    `ours ${(Number(ours) / 1e9 / 1e6).toFixed(3)}M coins vs rival ${(Number(rival) / 1e9 / 1e6).toFixed(3)}M coins → the rival pool gives ${better.toFixed(2)}% more, so any price-comparing router/aggregator sends the flow there`);

  // ---- what reaches the treasury?
  const claim = async () => progFor(T).methods.claimPoolFees().accounts(await w.claimFeesAccts(T.publicKey)).rpc();
  await claim(); // sweep what the earlier 1 SOL buy in OUR pool produced, so the baseline is clean
  const t0 = await w.tbal(w.treasury);
  for (let i = 0; i < 5; i++) { await w.swap(T, "buy", SOL / 2n, rivalPool); }
  await claim();
  const t1 = await w.tbal(w.treasury);
  const c2 = t1;
  for (let i = 0; i < 5; i++) { await w.swap(T, "buy", SOL / 2n, w.poolAddr); }
  await claim();
  const t2 = await w.tbal(w.treasury);
  const rivalEarnsNothing = t1 - t0 === 0n && t2 - c2 > 0n;
  const note53 = `via rival: +${(Number(t1 - t0) / 1e9).toFixed(4)} SOL to the treasury; via ours: +${(Number(t2 - c2) / 1e9).toFixed(4)} SOL (=${((Number(t2 - c2) / 2.5e9) * 100).toFixed(2)}% of the volume)`;
  const title53 = "treasury income from 2.5 SOL of volume through the RIVAL pool vs through OUR pool";
  if (rivalEarnsNothing) recordKnown("A5.3", title53, true, "PENDING", note53);
  else record("A5.3", title53, "INFO", note53);

  finish("audit/results_a5.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
