// owners_authority: link the Meteora pool to the state (one-time, cannot be changed).
// The program checks on-chain that the pool is governance coin / treasury asset with the fee taken
// only in token B, and that the Config PDA holds the position NFT.
//
//   GOVERNANCE_MINT=<mint>
//   POOL=<pool>  POSITION_NFT=<position NFT mint>    (or both read from ./.pool.json, see create_pool.ts)

import { PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "fs";
import {
  getProvider, loadProgram, GOVERNANCE_MINT, TOKEN_PROGRAM, ATA_PROGRAM, configPda, feeAAccount,
  meteoraPositionPda, meteoraPositionNftAccountPda, readPoolVaults,
} from "./lib/env";

async function main() {
  const saved = fs.existsSync(process.env.POOL_OUT ?? "./.pool.json") ? JSON.parse(fs.readFileSync(process.env.POOL_OUT ?? "./.pool.json", "utf8")) : {};
  const pool = new PublicKey(process.env.POOL ?? saved.pool);
  const nftMint = new PublicKey(process.env.POSITION_NFT ?? saved.positionNft);
  const provider = getProvider();
  const program = loadProgram(provider);

  const tx = await program.methods
    .registerPool()
    .accounts({
      owner: provider.wallet.publicKey,
      config: configPda(),
      governanceMint: GOVERNANCE_MINT,
      pool,
      position: meteoraPositionPda(nftMint),
      positionNftAccount: meteoraPositionNftAccountPda(nftMint),
      feeAAccount: feeAAccount(),
      governanceTokenProgram: TOKEN_PROGRAM,
      associatedTokenProgram: ATA_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const v = await readPoolVaults(provider.connection, pool);
  console.log("register_pool tx:", tx);
  console.log("pool", pool.toBase58(), "| vault A (excluded from the voting base)", v.vaultA.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
