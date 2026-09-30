# audit/ — abuse & security tests (no contract changes)

Written 2026-09-30 for the "is the contract safe against dishonest buyers / sellers / holders?" review.
Everything runs against a **local validator** with the **real bytecode** (`target/deploy/onchain_state_solana.so`,
sha256 `5e138c88ddc5d005a842ce76ccd0e9d0b6e5beeecbae9ff58497b680fdbc7237` — byte-identical to the mainnet program
`FG7Y…oQdy` as dumped on 2026-09-30) and a **cloned Meteora DAMM v2**. Throw-away keys only; the harness refuses any
RPC that is not `127.0.0.1` / `localhost`. Nothing here modifies `programs/onchain-state-solana/src/lib.rs`.

## Start the validator (needs internet to devnet once, to clone Meteora and two public pool configs)

```bash
solana-test-validator --reset --ledger /tmp/audit-ledger \
  --bpf-program FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy target/deploy/onchain_state_solana.so \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone 8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF --clone 82p7sVzQWZfCrmStPhsG8BYKwheQkUiXSs2wiqdhwNxr \
  --url https://api.devnet.solana.com
./audit/run_all.sh            # ~6 min; or run a single file:  ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a1_access.ts
```

## Files

| file | what it attacks | expected |
|---|---|---|
| `a1_access.ts` | authorisation and account substitution (fake token accounts, fake Meteora program, redirected fee/payout, non-owner/admin calls, re-initialize…) | all **BLOCKED** |
| `a2_voting_trading.ts` | wallet hopping, electorate lock-out, vote rental, quorum moved by pool trades, flash proposer, live mint authority | findings (**EXPLOITABLE**), with controls `A2.1c`, `A2.2c` |
| `a2b_hopping_scale.ts` | how far the hopping trick scales (10 wallets) | finding |
| `a2c_lp_quorum.ts` | quorum base moved by a stranger adding/removing liquidity (no swap fee) | finding |
| `a3_milestones.ts` | milestone payouts: hopping and flash-holder (buy → snapshot → sell → collect), 3 fund sizes | findings |
| `a4_init.ts` | `initialize` squatting / griefing / no parameter bounds / dangerous mint extensions; `register_pool` fee level | findings |
| `a5_competing_pool.ts` | a rival 0.25% pool for the same pair from a public Meteora config | finding |
| `a6_admin_pause.ts` | single-key powers: pause freezes governance, no admin rotation | findings |
| `a7_rogue_owner.ts` | a stolen / dishonest owner key without any vote: milestone fund drain, self-paying SPENDs | findings |
| `a8_position_delegate.ts` | hidden Meteora delegate left on the position before the NFT hand-over | **BLOCKED** (cleared by the hand-over) |
| `a1b_arbitrary_cpi.ts` | fake program in the token-program slot (arbitrary CPI) | all **BLOCKED** |
| `inspect_mainnet.ts`, `program_authority.ts`, `meteora_configs.ts`, `inspect_position_nft.ts` | READ-ONLY looks at mainnet / devnet (authorities, Meteora public configs) | data |

Verdict legend: `BLOCKED` the attack failed (good) · `EXPLOITABLE` the attack worked on the real bytecode (a finding) ·
`OK` positive control · `INFO` measurement · `ERROR` the harness failed (look at it). Each run writes `audit/results_*.json`.
