// READ-ONLY: who can touch our locked-liquidity position? Looks at the position NFT mint and its token account
// (owner, delegate, close authority, mint/freeze/permanent-delegate authorities, extensions) for the mainnet "Test 1" state.
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { getMint, getAccount, TOKEN_2022_PROGRAM_ID, getExtensionTypes, getPermanentDelegate, getMintCloseAuthority } from "@solana/spl-token";
import * as fs from "fs";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
async function retry<T>(f: () => Promise<T>): Promise<T> { let e: any; for (let i = 0; i < 6; i++) { try { return await f(); } catch (x) { e = x; await new Promise(r => setTimeout(r, 1500)); } } throw e; }
(async () => {
  const c = new Connection(RPC, "confirmed");
  const IDL = JSON.parse(fs.readFileSync("./idl/onchain_state_solana.json", "utf8"));
  const dummy = new anchor.AnchorProvider(c, new anchor.Wallet(anchor.web3.Keypair.generate()), {});
  const program = new anchor.Program(IDL, dummy) as any;
  const cfgPk = new PublicKey(process.env.CONFIG || "4PV3WwErDGfBZbGYidfeN46H4rZ3PKS1NZ9HiDeyNgaT");
  const cfg: any = await retry(() => program.account.config.fetch(cfgPk));
  console.log("pool", cfg.feePool.toBase58(), "\nposition", cfg.feePosition.toBase58(), "\nnft account", cfg.feePositionNftAccount.toBase58());
  for (const prog of [TOKEN_2022_PROGRAM_ID]) {
    const acc = await retry(() => getAccount(c, cfg.feePositionNftAccount, "confirmed", prog));
    console.log("NFT token account: owner", acc.owner.toBase58(), "| amount", acc.amount.toString(), "| delegate", acc.delegate?.toBase58() ?? "None", "| closeAuthority", acc.closeAuthority?.toBase58() ?? "None");
    console.log("  extensions", getExtensionTypes(acc.tlvData).map(String));
    const m = await retry(() => getMint(c, acc.mint, "confirmed", prog));
    console.log("NFT mint", acc.mint.toBase58(), "| supply", m.supply.toString(), "| mintAuthority", m.mintAuthority?.toBase58() ?? "None", "| freezeAuthority", m.freezeAuthority?.toBase58() ?? "None");
    console.log("  extensions", getExtensionTypes(m.tlvData).map(String));
    try { console.log("  permanentDelegate", getPermanentDelegate(m)?.delegate.toBase58() ?? "None"); } catch {}
    try { console.log("  mintCloseAuthority", getMintCloseAuthority(m)?.closeAuthority.toBase58() ?? "None"); } catch {}
  }
  const pos = await retry(() => c.getAccountInfo(cfg.feePosition));
  const d = pos!.data;
  // Position: 8 disc, pool 32, nft_mint 32, fee checkpoints 32+32, fee pending 8+8, unlocked u128, vested u128, permanent_locked u128 ...
  const u128 = (o: number) => { let v = 0n; for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
  console.log("position liquidity: unlocked", u128(152).toString(), "| vested", u128(168).toString(), "| permanently locked", u128(184).toString());
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
