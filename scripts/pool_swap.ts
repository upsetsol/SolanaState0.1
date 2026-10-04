// Buy or sell the governance coin in the state's Meteora pool (a test tool — the same swap a
// normal trader does on meteora.ag / Jupiter). The pool fee is taken inside the swap.
//
//   GOVERNANCE_MINT=<mint>   TREASURY_MINT=<mint> (optional, default wSOL)
//   SIDE=buy|sell            buy = pay the treasury asset, receive coins; sell = the reverse
//   AMOUNT=<whole units>     what you PAY (SOL/USDC for buy, coins for sell)
//   SLIPPAGE=5               percent (optional)
//   KEYPAIR=~/trader.json    trader wallet (optional, default ANCHOR_WALLET)

import { TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import BN from "bn.js";
import { CpAmm, deriveCustomizablePoolAddress } from "@meteora-ag/cp-amm-sdk";
import { parseUnits, getProvider, chainNow, GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, TOKEN_PROGRAM } from "./lib/env";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const side = (process.env.SIDE ?? "buy").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new Error("SIDE must be buy or sell");
  const gov = await getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM);
  const quote = await getMint(conn, TREASURY_MINT, "confirmed", TREASURY_PROGRAM);
  const decIn = side === "buy" ? quote.decimals : gov.decimals;
  const amountIn = new BN(parseUnits(process.env.AMOUNT ?? "0.01", decIn).toString());

  const cpAmm = new CpAmm(conn);
  const pool = deriveCustomizablePoolAddress(GOVERNANCE_MINT, TREASURY_MINT);
  const state: any = await cpAmm.fetchPoolState(pool);
  const inMint = side === "buy" ? TREASURY_MINT : GOVERNANCE_MINT;
  const outMint = side === "buy" ? GOVERNANCE_MINT : TREASURY_MINT;
  const slot = await conn.getSlot();
  const now = await chainNow(conn);
  const q: any = cpAmm.getQuote({
    inAmount: amountIn, inputTokenMint: inMint, slippage: Number(process.env.SLIPPAGE ?? "5"), poolState: state, currentTime: now, currentSlot: slot,
    tokenADecimal: gov.decimals, tokenBDecimal: quote.decimals,
  } as any);
  const tx = await cpAmm.swap({
    payer: provider.wallet.publicKey, pool, inputTokenMint: inMint, outputTokenMint: outMint, amountIn, minimumAmountOut: q.minSwapOutAmount ?? new BN(0),
    tokenAMint: GOVERNANCE_MINT, tokenBMint: TREASURY_MINT, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TREASURY_PROGRAM, referralTokenAccount: null, poolState: state,
  } as any);
  const sig = await provider.sendAndConfirm(tx);
  console.log(`${side} ${process.env.AMOUNT ?? "0.01"}: in ${amountIn.toString()} raw -> quoted out ${q.swapOutAmount?.toString?.() ?? "?"} raw, fee ${q.totalFee?.toString?.() ?? "?"} | tx ${sig}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
