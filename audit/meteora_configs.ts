// READ-ONLY: list Meteora DAMM v2 public Config accounts (anyone can create a pool from a config whose
// pool_creator_authority is the zero key) and how much fee they charge — i.e. what a competing pool could charge.
import { Connection, PublicKey } from "@solana/web3.js";
import { CpAmm, feeNumeratorToBps, decodePodAlignedFeeTimeScheduler, getBaseFeeModeFromPodAlignedData } from "@meteora-ag/cp-amm-sdk";
const RPC = process.env.RPC || "https://api.devnet.solana.com";
(async () => {
  const c = new Connection(RPC, "confirmed");
  const cp = new CpAmm(c);
  let list: any[] = [];
  for (let i = 0; i < 5; i++) { try { list = await cp.getAllConfigs(); break; } catch (e: any) { console.log("retry:", String(e.message).slice(0, 160)); await new Promise(r => setTimeout(r, 2000)); } }
  console.log("RPC", RPC.replace(/api-key=[^&]+/, "api-key=***"), " configs:", list.length);
  const byKey: Record<string, number> = {};
  let sample = 0;
  const rows: any[] = [];
  for (const it of list) {
    const s = it.account ?? it;
    const isPublic = s.poolCreatorAuthority?.toBase58?.() === PublicKey.default.toBase58();
    let cliff = -1, mode = -1, periods = -1;
    try {
      const data = s.poolFees.baseFee.data ?? s.poolFees.baseFee;
      mode = getBaseFeeModeFromPodAlignedData(Buffer.from(data));
      const dec: any = decodePodAlignedFeeTimeScheduler(Buffer.from(data));
      cliff = feeNumeratorToBps(dec.cliffFeeNumerator); periods = Number(dec.numberOfPeriod);
    } catch (e) { /* other scheduler kind */ }
    rows.push({ pk: (it.publicKey ?? it.pubkey).toBase58(), isPublic, collect: s.collectFeeMode, cliff, mode, periods, act: s.activationType });
    const k = `public=${isPublic} collect=${s.collectFeeMode}`; byKey[k] = (byKey[k] ?? 0) + 1;
  }
  console.log(byKey);
  const pub = rows.filter(r => r.isPublic && r.collect !== 2); // non-compounding (compounding is a different pool type)
  const fees = pub.map(r => r.cliff).filter(x => x >= 0).sort((a, b) => a - b);
  console.log("public non-compounding configs:", pub.length, " starting-fee bps distribution (min…max):", fees.slice(0, 8).join(","), "…", fees.slice(-5).join(","));
  const cheap = pub.filter(r => r.periods === 0 && r.cliff >= 0).sort((a, b) => a.cliff - b.cliff);
  console.log('static-fee (no scheduler) public configs:', cheap.length);
  for (const r of cheap.slice(0, 12)) console.log(JSON.stringify(r));
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
// ---- extra: cheapest static public configs
