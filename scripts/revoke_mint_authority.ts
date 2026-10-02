// Gives up the right to print more coins (and, optionally, to change the coin's name/logo) FOR EVER. Do it right after the pool is created.
// Irreversible: without CONFIRM=yes it only prints what it would do.
//
//   GOVERNANCE_MINT=<mint>   KEYPAIR/ANCHOR_WALLET = the current mint authority (the coin creator)
//   ALSO_METADATA=yes        (optional) also revoke the metadata update authority and the metadata-pointer authority (the name/logo can never change)
//   CONFIRM=yes
import { Transaction } from "@solana/web3.js";
import { AuthorityType, createSetAuthorityInstruction, getMint } from "@solana/spl-token";
import { createUpdateAuthorityInstruction } from "@solana/spl-token-metadata";
import { getProvider, GOVERNANCE_MINT, TOKEN_PROGRAM } from "./lib/env";
import { requireConfirm, retry } from "./lib/pool";

async function main() {
  const provider = getProvider();
  const me = provider.wallet.publicKey;
  const mint = await retry(() => getMint(provider.connection, GOVERNANCE_MINT, "confirmed", TOKEN_PROGRAM));
  console.log("coin:", GOVERNANCE_MINT.toBase58(), "| supply", Number(mint.supply) / 10 ** mint.decimals);
  console.log("mint authority now:", mint.mintAuthority?.toBase58() ?? "none (already revoked)");
  if (!mint.mintAuthority) { console.log("nothing to do"); return; }
  if (!mint.mintAuthority.equals(me)) throw new Error("this wallet is not the mint authority");
  const alsoMeta = process.env.ALSO_METADATA === "yes";
  console.log(`will revoke: mint authority${alsoMeta ? " + metadata update authority + metadata-pointer authority" : ""}  (IRREVERSIBLE)`);
  requireConfirm("revoke the authority for ever");
  const tx = new Transaction().add(createSetAuthorityInstruction(GOVERNANCE_MINT, me, AuthorityType.MintTokens, null, [], TOKEN_PROGRAM));
  if (alsoMeta) {
    tx.add(createUpdateAuthorityInstruction({ programId: TOKEN_PROGRAM, metadata: GOVERNANCE_MINT, oldAuthority: me, newAuthority: null }));
    tx.add(createSetAuthorityInstruction(GOVERNANCE_MINT, me, AuthorityType.MetadataPointer, null, [], TOKEN_PROGRAM));
  }
  console.log("DONE, tx", await provider.sendAndConfirm(tx));
}
main().catch((e) => { console.error(e); process.exit(1); });
