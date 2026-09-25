// claim_pool_fees — permissionless. Pulls the trading fee that piled up on the pool position into the
// treasury (the destination is fixed in the program: nobody can redirect it). Not pause-gated: it is an
// inflow. Anyone can run it, any time; the fee never expires. Costs one normal transaction fee.
//
//   GOVERNANCE_MINT=<mint>   TREASURY_MINT=<mint> (optional, default wSOL)

import {
  getProvider, loadProgram, GOVERNANCE_MINT, TREASURY_MINT, TOKEN_PROGRAM, TREASURY_PROGRAM, METEORA_CP_AMM,
  METEORA_POOL_AUTHORITY, METEORA_EVENT_AUTHORITY, configPda, treasuryAta, feeAAccount, readPoolVaults, readPendingPoolFee,
} from "./lib/env";
import { getAccount } from "@solana/spl-token";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const cfg = await program.account.config.fetch(configPda());
  const { vaultA, vaultB } = await readPoolVaults(provider.connection, cfg.feePool);

  const pending = await readPendingPoolFee(provider.connection, cfg.feePool, cfg.feePosition);
  console.log("pending fee on the position (raw units of the treasury asset):", pending.feeB.toString());
  const before = (await getAccount(provider.connection, treasuryAta(), "confirmed", TREASURY_PROGRAM)).amount;
  const tx = await program.methods
    .claimPoolFees()
    .accounts({
      caller: provider.wallet.publicKey,
      config: configPda(),
      governanceMint: GOVERNANCE_MINT,
      treasuryMint: TREASURY_MINT,
      treasury: treasuryAta(),
      feeAAccount: feeAAccount(),
      poolAuthority: METEORA_POOL_AUTHORITY,
      pool: cfg.feePool,
      position: cfg.feePosition,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      positionNftAccount: cfg.feePositionNftAccount,
      tokenAProgram: TOKEN_PROGRAM,
      tokenBProgram: TREASURY_PROGRAM,
      eventAuthority: METEORA_EVENT_AUTHORITY,
      meteoraProgram: METEORA_CP_AMM,
    })
    .rpc();
  const after = (await getAccount(provider.connection, treasuryAta(), "confirmed", TREASURY_PROGRAM)).amount;
  console.log("claim_pool_fees tx:", tx, "| treasury +", (after - before).toString(), "(raw units of the treasury asset)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
