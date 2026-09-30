// A8 — can the pool creator leave a hidden backdoor on the locked position before handing the NFT to the Config PDA?
// Meteora lets a position owner approve a DELEGATE (an SPL delegate on the position-NFT token account + a permission
// bitmask on the Position) who may claim fees to any account / remove unlocked liquidity.  If that delegate survived the
// hand-over, "the fee can only land on the treasury" would be false.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a8_position_delegate.ts
import { getAccount } from "@solana/spl-token";
import { PositionDelegatePermission, encodeDelegatePermissions } from "@meteora-ag/cp-amm-sdk";
import { makeWorld, group, record, newFunded, conn, TP, SOL, finish } from "./lib";

async function main() {
  group("A8 hidden position delegate");
  const w = await makeWorld({ name: "a8" });
  const evil = await newFunded(5);
  let before: any = null;
  await w.withPool(300_000_000n, 30n * SOL, 500, async ({ positionNft, nftAccount }) => {
    const tx = await (w.cpAmm as any).updateDelegatePermission({
      owner: w.me, positionNft: positionNft.publicKey, delegate: evil.publicKey,
      permission: encodeDelegatePermissions([PositionDelegatePermission.ClaimPositionFee, PositionDelegatePermission.RemoveLiquidity, PositionDelegatePermission.ClaimPositionFeeToOwner]),
    });
    await w.provider.sendAndConfirm(tx);
    before = await getAccount(conn, nftAccount, "confirmed", TP);
  });
  record("A8.0", "setup: a delegate WAS approved on the position-NFT account before the hand-over", before?.delegate?.equals(evil.publicKey) ? "INFO" : "ERROR", `delegate before hand-over: ${before?.delegate?.toBase58()?.slice(0, 8) ?? "none"}`);
  const after = await getAccount(conn, w.poolInfo!.nftAccount, "confirmed", TP);
  const survived = !!after.delegate;
  record("A8.1", "…does the delegate survive SetAuthority(owner → Config PDA) and register_pool?", survived ? "EXPLOITABLE" : "BLOCKED",
    `after hand-over: owner=${after.owner.toBase58().slice(0, 8)} (Config PDA ${w.configPda.toBase58().slice(0, 8)}), delegate=${after.delegate?.toBase58() ?? "None"}, delegated amount=${after.delegatedAmount}`);
  finish("audit/results_a8.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
