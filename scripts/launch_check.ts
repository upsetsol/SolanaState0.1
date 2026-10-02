// READ-ONLY checklist after a launch: is the state what we promised? Sends nothing.
//   GOVERNANCE_MINT=<mint>  ANCHOR_PROVIDER_URL=<rpc>  DEV=<the creator's wallet address>
import { Connection, PublicKey } from "@solana/web3.js";
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { derivePositionNftAccount, CollectFeeMode } from "@meteora-ag/cp-amm-sdk";
import { GOVERNANCE_MINT, TOKEN_PROGRAM, PROGRAM_ID, loadProgram } from "./lib/env";
import * as anchor from "@coral-xyz/anchor";
import { loadPool, liquidityOf, retry } from "./lib/pool";

async function main() {
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
  const { cp, pool, state, gov } = await loadPool(conn);
  const config = PublicKey.findProgramAddressSync([Buffer.from("config"), GOVERNANCE_MINT.toBuffer()], PROGRAM_ID)[0];
  const program = loadProgram(new anchor.AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, {}));
  const cfg: any = await retry(() => program.account.config.fetch(config));
  const mint = await retry(() => getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  const supply = BigInt(mint.supply.toString());
  const vaultA = (await retry(() => getAccount(conn, state.tokenAVault, "confirmed", TOKEN_PROGRAM))).amount;
  const checks: [string, boolean, string][] = [];
  const add = (name: string, ok: boolean, note: string) => checks.push([name, ok, note]);

  if (process.env.DEV) {
    const dev = new PublicKey(process.env.DEV);
    const bal = await getAccount(conn, getAssociatedTokenAddressSync(GOVERNANCE_MINT, dev, false, TOKEN_PROGRAM), "confirmed", TOKEN_PROGRAM).then((a) => a.amount, () => 0n);
    add("the creator holds ZERO coins", bal === 0n, `creator ${dev.toBase58().slice(0, 6)}… holds ${Number(bal) / 10 ** gov.decimals} coins`);
  }
  add("the pool holds (almost) the whole supply", vaultA * 100n >= supply * 95n, `pool vault: ${(Number(vaultA * 10000n / supply) / 100).toFixed(2)} % of the supply (${Number(vaultA) / 10 ** gov.decimals} coins)`);
  add("nobody can print more coins (mint authority revoked)", mint.mintAuthority === null, `mint authority: ${mint.mintAuthority?.toBase58() ?? "none"}`);
  add("no freeze authority", mint.freezeAuthority === null, `freeze authority: ${mint.freezeAuthority?.toBase58() ?? "none"}`);
  add("the state is linked to this pool", cfg.feePool.toBase58() === pool.toBase58(), `config.fee_pool ${cfg.feePool.toBase58().slice(0, 6)}…`);
  const pos = await retry(() => cp.fetchPositionState(cfg.feePosition));
  const nftAccount = derivePositionNftAccount(pos.nftMint);
  const nftInfo = await retry(() => conn.getAccountInfo(nftAccount));
  add("the position NFT is owned by the state (Config PDA)", !!nftInfo && new PublicKey(nftInfo.data.subarray(32, 64)).equals(config), `NFT account owner ${nftInfo ? new PublicKey(nftInfo.data.subarray(32, 64)).toBase58().slice(0, 6) + "…" : "?"}`);
  add("the liquidity is locked for ever", liquidityOf(pos).gt(liquidityOf(pos).muln(0)) && pos.unlockedLiquidity.toString() === "0" && pos.permanentLockedLiquidity.toString() !== "0", `unlocked ${pos.unlockedLiquidity.toString()} / permanently locked ${pos.permanentLockedLiquidity.toString().slice(0, 8)}…`);
  add("the fee is taken only in the treasury asset", Number(state.collectFeeMode) === Number(CollectFeeMode.OnlyB), `collect fee mode ${state.collectFeeMode}`);
  const feeData = Buffer.from(state.poolFees.baseFee.baseFeeInfo.data); // pod-aligned: first 8 bytes = fee numerator (1e9 = 100%), the rest = schedule (all zero = flat)
  const feeBps = Number(feeData.readBigUInt64LE(0) / 100_000n);
  const flat = feeData.subarray(8).every((b) => b === 0);
  add("the fee is 5% and flat (no schedule, no dynamic part)", feeBps === 500 && flat && Number(state.poolFees.dynamicFee?.initialized ?? 0) === 0, `fee ${feeBps / 100} %, flat=${flat}`);
  add("Meteora's cut is 20% of the fee (the rest, 80%, goes to the liquidity owners)", Number(state.poolFees.protocolFeePercent) === 20, `protocol fee ${state.poolFees.protocolFeePercent} %`);
  const total = new (require("bn.js"))(state.liquidity.toString());
  add("the state owns 100% of the pool's liquidity", liquidityOf(pos).eq(total), `state share ${(Number(liquidityOf(pos).mul(new (require("bn.js"))(10000)).div(total)) / 100).toFixed(2)} %`);
  console.log(`LAUNCH CHECK for ${GOVERNANCE_MINT.toBase58()} (pool ${pool.toBase58()})`);
  for (const [n, ok, note] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}  — ${note}`);
  console.log(checks.every((c) => c[1]) ? "\nALL PASS" : "\nSOME CHECKS FAILED");
  process.exitCode = checks.every((c) => c[1]) ? 0 : 1;
}
main().catch((e) => { console.error(e); process.exit(1); });
