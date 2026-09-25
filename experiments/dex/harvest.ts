// Can the withheld tax be harvested from the POOL accounts (DAMM v2 vault + DLMM reserve)?
// Uses the same permissionless Token-2022 instruction our harvest_fees program calls.
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, harvestWithheldTokensToMint, withdrawWithheldTokensFromMint, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import DLMM, { LBCLMM_PROGRAM_IDS, deriveCustomizablePermissionlessLbPair } from "@meteora-ag/dlmm";
import { CpAmm, deriveCustomizablePoolAddress } from "@meteora-ag/cp-amm-sdk";
import { connection, payer, getOrCreateMint, withheldOn, ui, tokenBalance } from "./common";

async function main() {
  const ours = await getOrCreateMint();
  const oursIsFirst = Buffer.compare(ours.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
  const [a, b] = oursIsFirst ? [ours, NATIVE_MINT] : [NATIVE_MINT, ours];

  const cp = new CpAmm(connection);
  const dammState: any = await cp.fetchPoolState(deriveCustomizablePoolAddress(a, b));
  const dammVault: PublicKey = oursIsFirst ? dammState.tokenAVault : dammState.tokenBVault;

  const dlmmProgram = new PublicKey(String((LBCLMM_PROGRAM_IDS as any)["devnet"]));
  const dlmm = await DLMM.create(connection, deriveCustomizablePermissionlessLbPair(a, b, dlmmProgram)[0], { cluster: "devnet" } as any);
  const dlmmReserve: PublicKey = oursIsFirst ? dlmm.lbPair.reserveX : dlmm.lbPair.reserveY;

  const sources = [dammVault, dlmmReserve];
  console.log("withheld on DAMM v2 vault:", ui(await withheldOn(dammVault)), "| DLMM reserve:", ui(await withheldOn(dlmmReserve)));

  await harvestWithheldTokensToMint(connection, payer, ours, sources, undefined, TOKEN_2022_PROGRAM_ID);
  console.log("after harvest -> DAMM v2 vault:", ui(await withheldOn(dammVault)), "| DLMM reserve:", ui(await withheldOn(dlmmReserve)));

  const dest = await getOrCreateAssociatedTokenAccount(connection, payer, ours, payer.publicKey, false, undefined, undefined, TOKEN_2022_PROGRAM_ID);
  const before = await tokenBalance(payer.publicKey, ours);
  await withdrawWithheldTokensFromMint(connection, payer, ours, dest.address, payer, [], undefined, TOKEN_2022_PROGRAM_ID);
  console.log(`withdrawn from the mint into the collector account: +${ui((await tokenBalance(payer.publicKey, ours)) - before)} tokens`);
  console.log("\nHARVEST RESULT: pool accounts can be harvested by anyone; the bot must include them.");
}
main().catch((e) => { console.error("HARVEST FAILED:", e?.message ?? e); process.exit(1); });
