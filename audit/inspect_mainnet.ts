// READ-ONLY look at the mainnet "Test 1" deployment: who holds which authority. No keys, no sends.
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, getExtensionTypes, getTokenMetadata, getMetadataPointerState } from "@solana/spl-token";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
(async () => {
  const c = new Connection(RPC, "confirmed");
  const mint = new PublicKey("GFCg1WqNBHwRHHaw5eXH2SioKTpuqjcCn8tznxPunvSZ");
  const m = await getMint(c, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
  console.log("supply", m.supply.toString(), "decimals", m.decimals);
  console.log("mintAuthority  ", m.mintAuthority?.toBase58() ?? "None (revoked)");
  console.log("freezeAuthority", m.freezeAuthority?.toBase58() ?? "None (revoked)");
  console.log("extensions", getExtensionTypes(m.tlvData).map(String));
  try { const mp = getMetadataPointerState(m); console.log("metadataPointer authority", mp?.authority?.toBase58(), "->", mp?.metadataAddress?.toBase58()); } catch (e) {}
  try { const md = await getTokenMetadata(c, mint, "confirmed", TOKEN_2022_PROGRAM_ID); console.log("metadata updateAuthority", md?.updateAuthority?.toBase58(), md?.name, md?.symbol); } catch (e) {}
  const cfg = new PublicKey("4PV3WwErDGfBZbGYidfeN46H4rZ3PKS1NZ9HiDeyNgaT");
  const info = await c.getAccountInfo(cfg);
  console.log("Config account owner", info?.owner.toBase58(), "bytes", info?.data.length);
  // decode a few Config fields by offset: 8 disc + 5 pubkeys(owners,admin,president,finance,culture)
  const d = info!.data; const k = (o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();
  console.log("owners_authority", k(8), "\nadmin_authority ", k(40), "\npresident       ", k(72));
})();
