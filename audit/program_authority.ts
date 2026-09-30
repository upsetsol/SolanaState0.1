// READ-ONLY: who can upgrade a given program on a cluster (BPF Upgradeable Loader ProgramData layout).
import { Connection, PublicKey } from "@solana/web3.js";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
async function retry<T>(f: () => Promise<T>): Promise<T> { let e: any; for (let i = 0; i < 6; i++) { try { return await f(); } catch (x) { e = x; await new Promise(r => setTimeout(r, 1500)); } } throw e; }
(async () => {
  const c = new Connection(RPC, "confirmed");
  for (const id of process.argv.slice(2)) {
    const prog = await retry(() => c.getAccountInfo(new PublicKey(id)));
    if (!prog) { console.log(id, "not found"); continue; }
    const pd = new PublicKey(prog.data.subarray(4, 36));
    const d = await retry(() => c.getAccountInfo(pd));
    const has = d!.data[12] === 1;
    const auth = has ? new PublicKey(d!.data.subarray(13, 45)).toBase58() : "None (immutable)";
    console.log(id, "\n  programdata", pd.toBase58(), "\n  last deployed slot", d!.data.readBigUInt64LE(4).toString(), "\n  upgrade authority:", auth);
  }
})();
