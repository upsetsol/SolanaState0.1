// Sets (or changes) the metadata link of the governance coin: the JSON with the name and logo that wallets and explorers show.
// Works only while the metadata update authority is still this wallet (before scripts/revoke_metadata.ts). The extra rent for a longer link is paid from this wallet.
//
//   GOVERNANCE_MINT=<mint>  URI=<https://...json>  KEYPAIR or ANCHOR_WALLET = the metadata update authority (the coin creator)  CONFIRM=yes (without it: dry run)
import { SystemProgram, Transaction } from "@solana/web3.js";
import { getTokenMetadata } from "@solana/spl-token";
import { createUpdateFieldInstruction, Field, pack } from "@solana/spl-token-metadata";
import { getProvider, GOVERNANCE_MINT, TOKEN_PROGRAM } from "./lib/env";
import { requireConfirm, retry } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const uri = process.env.URI;
  if (!uri) throw new Error("set URI=<link to the metadata json>");
  const md = await retry(() => getTokenMetadata(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  if (!md) throw new Error("this coin has no on-chain metadata");
  console.log(`coin ${GOVERNANCE_MINT.toBase58()}: name "${md.name}", symbol "${md.symbol}"`);
  console.log(`link now : ${md.uri || "(empty)"}`);
  console.log(`link new : ${uri}`);
  if (!md.updateAuthority) throw new Error("the metadata update authority is already revoked - the link can never be changed");
  if (!md.updateAuthority.equals(me)) throw new Error(`this wallet (${me.toBase58()}) is not the metadata update authority (${md.updateAuthority.toBase58()})`);

  // a longer link makes the account bigger: it must stay rent-exempt, so the difference is paid first
  const acc = (await retry(() => conn.getAccountInfo(GOVERNANCE_MINT, "confirmed")))!;
  const grow = pack({ ...md, uri }).length - pack(md).length;
  const need = grow > 0 ? await conn.getMinimumBalanceForRentExemption(acc.data.length + grow) : 0;
  const extra = Math.max(0, need - acc.lamports);
  console.log(`account grows by ${Math.max(0, grow)} bytes, extra rent ${(extra / 1e9).toFixed(6)} SOL`);
  requireConfirm("set the metadata link");
  const tx = new Transaction();
  if (extra > 0) tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: GOVERNANCE_MINT, lamports: extra }));
  tx.add(createUpdateFieldInstruction({ programId: TOKEN_PROGRAM, metadata: GOVERNANCE_MINT, updateAuthority: me, field: Field.Uri, value: uri }));
  console.log("DONE, tx", await provider.sendAndConfirm(tx));
  const after = await retry(() => getTokenMetadata(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  console.log(`link on chain now: ${after?.uri}`);
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
