// Shared helpers for the liquidity tools (add_liquidity / remove_liquidity / pool_report / send_coins).
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import BN from "bn.js";
import { CpAmm, deriveCustomizablePoolAddress, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { GOVERNANCE_MINT, TREASURY_MINT, TREASURY_PROGRAM, TOKEN_PROGRAM } from "./env";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Public RPCs drop requests now and then — retry reads. */
export async function retry<T>(f: () => Promise<T>, tries = 6): Promise<T> {
  let e: any;
  for (let i = 0; i < tries; i++) { try { return await f(); } catch (x) { e = x; await sleep(1500); } }
  throw e;
}
export const fmt = (raw: BN | bigint | string, dec = 9, digits = 6) => (Number(raw.toString()) / 10 ** dec).toFixed(digits);

export async function loadPool(conn: Connection) {
  const cp = new CpAmm(conn);
  const pool = deriveCustomizablePoolAddress(GOVERNANCE_MINT, TREASURY_MINT);
  const state: any = await retry(() => cp.fetchPoolState(pool));
  const gov = await retry(() => getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  const quote = await retry(() => getMint(conn, TREASURY_MINT, "confirmed", TREASURY_PROGRAM));
  return { cp, pool, state, gov, quote };
}
export const liquidityOf = (p: any): BN =>
  new BN(p.unlockedLiquidity.toString()).add(new BN(p.vestedLiquidity.toString())).add(new BN(p.permanentLockedLiquidity.toString()));
/** Fee (token B, i.e. the treasury asset) that a position could claim right now. */
export const unclaimedB = (state: any, pos: any): BN => new BN(getUnClaimLpFee(state, pos).feeTokenB.toString());
export function requireConfirm(what: string) {
  if (process.env.CONFIRM !== "yes") {
    console.log(`\nDRY RUN — nothing was sent. To really do it (${what}) run the same command again with CONFIRM=yes in front.`);
    process.exit(0);
  }
}
export function rpcLooksLikeMainnet() { return /mainnet/i.test(process.env.ANCHOR_PROVIDER_URL ?? ""); }
export const short = (k: PublicKey | string) => { const s = k.toString(); return s.slice(0, 4) + "…" + s.slice(-4); };
