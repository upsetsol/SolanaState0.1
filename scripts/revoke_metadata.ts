// Gives up, FOR EVER, the right to change the coin's name, symbol and logo link (the metadata update authority and the metadata-pointer authority).
// Use it after the link is final (scripts/set_metadata_uri.ts) and the right to print coins is already revoked (scripts/revoke_mint_authority.ts).
// IRREVERSIBLE: without CONFIRM=yes it only prints what it would do.
//
//   GOVERNANCE_MINT=<mint>   KEYPAIR or ANCHOR_WALLET = the current metadata update authority (the coin creator)   CONFIRM=yes
import { Transaction } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction, getMetadataPointerState, getMint, getTokenMetadata } from "@solana/spl-token";
import { createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";
import { getProvider, GOVERNANCE_MINT, TOKEN_PROGRAM } from "./lib/env";
import { requireConfirm, retry } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const mint = await retry(() => getMint(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  const md = await retry(() => getTokenMetadata(conn, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  const ptr = getMetadataPointerState(mint);
  console.log(`coin ${GOVERNANCE_MINT.toBase58()}: name "${md?.name}", symbol "${md?.symbol}", link ${md?.uri || "(empty)"}`);
  console.log(`mint authority          : ${mint.mintAuthority?.toBase58() ?? "none (revoked)"}`);
  console.log(`metadata update authority: ${md?.updateAuthority?.toBase58() ?? "none (revoked)"}`);
  console.log(`metadata-pointer authority: ${ptr?.authority?.toBase58() ?? "none (revoked)"}`);
  const doUpdate = !!md?.updateAuthority && md.updateAuthority.equals(me);
  const doPointer = !!ptr?.authority && ptr.authority.equals(me);
  if (md?.updateAuthority && !doUpdate) throw new Error(`the metadata update authority is ${md.updateAuthority.toBase58()}, not this wallet`);
  if (ptr?.authority && !doPointer) throw new Error(`the metadata-pointer authority is ${ptr.authority.toBase58()}, not this wallet`);
  if (!doUpdate && !doPointer) { console.log("nothing to do (already revoked)"); return; }
  if (mint.mintAuthority) console.log("NOTE: the right to print coins is NOT revoked yet (scripts/revoke_mint_authority.ts)");
  console.log(`will revoke for ever: ${[doUpdate && "metadata update authority", doPointer && "metadata-pointer authority"].filter(Boolean).join(" + ")}`);
  requireConfirm("revoke the metadata authorities for ever");
  const tx = new Transaction();
  if (doUpdate) tx.add(createUpdateAuthorityInstruction({ programId: TOKEN_PROGRAM, metadata: GOVERNANCE_MINT, oldAuthority: me, newAuthority: null }));
  if (doPointer) tx.add(createSetAuthorityInstruction(GOVERNANCE_MINT, me, AuthorityType.MetadataPointer, null, [], TOKEN_PROGRAM));
  console.log("DONE, tx", await provider.sendAndConfirm(tx));
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
