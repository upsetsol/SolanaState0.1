# audit/ — abuse & security tests (no contract changes)

Written 2026-09-30 for the "is the contract safe against dishonest buyers / sellers / holders?" review, and **re-run the same
day against v4.1** (the fixes that came out of that review).
Everything runs against a **local validator** with the **real bytecode** and a **cloned Meteora DAMM v2**. Throw-away keys only; the
harness refuses any RPC that is not `127.0.0.1` / `localhost`. Nothing here modifies `programs/onchain-state-solana/src/lib.rs`.

| run | binary | where the results are |
|---|---|---|
| first run (2026-09-30) | **v4** = what is on mainnet "Test 1": sha256 `5e138c88ddc5d005a842ce76ccd0e9d0b6e5beeecbae9ff58497b680fdbc7237` (copy in `target/backup/`) | `audit/results_v4/results_*.json`; described in `REPORT.md` §1–§5 |
| second run (2026-09-30) | **v4.1** = `target/deploy/onchain_state_solana.so` (build of branch `pool-fees`), sha256 `563ccd0c4967cdcbfcbbd4eb4a1b0a1549b6ec2b992621a7e927689f7a296cc8` | `audit/results_*.json`; status table at the top of `REPORT.md` |

## Start the validator (needs internet to devnet once, to clone Meteora and two public pool configs)

```bash
solana-test-validator --reset --ledger /tmp/audit-ledger \
  --bpf-program FG7YYNJpcUHfHztKVou8yTLhZPntL6iR8fkRocW4oQdy target/deploy/onchain_state_solana.so \
  --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG \
  --clone 8CNy9goNQNLM4wtgRw528tUQGMKD3vSuFRZY2gLGLLvF --clone 82p7sVzQWZfCrmStPhsG8BYKwheQkUiXSs2wiqdhwNxr \
  --url https://api.devnet.solana.com
./audit/run_all.sh            # ~15 min; or run a single file:  ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a1_access.ts
```
To repeat the **v4** run, point `--bpf-program` at `target/backup/onchain_state_solana.mainnet-test1-2026-09-28.so` and use the IDL/harness of commit `a2fff45`
(the harness of this folder speaks the v4.1 instruction set).

## The v4.1 voting order the tests follow

`create_proposal` → the owner posts snapshots **with the weights of ONE scan** (`post_voter_snapshot(voter, weight)`; the contract only checks `0 < weight ≤ balance right now`)
→ `open_voting` (freezes the quorum base, starts the clock; snapshots are refused from now on) → `vote` → `execute_proposal`. `lib.ts` has the helpers
(`snapshot(..., weight?)`, `openVoting`, `scan`-style weights are read in the test itself).

## Files

| file | what it attacks | expected on v4.1 |
|---|---|---|
| `a1_access.ts` | authorisation and account substitution (fake token accounts, fake Meteora program, redirected fee/payout, non-owner/admin calls, re-initialize, open_voting without the pool vault…) | all **BLOCKED** |
| `a1b_arbitrary_cpi.ts` | fake program in the token-program slot (arbitrary CPI) | all **BLOCKED** |
| `a2_voting_trading.ts` | wallet hopping, electorate lock-out, vote rental, quorum moved by pool trades, flash proposer, live mint authority | hopping (scan weights), lock-out, quorum veto/push, mint after the start → **BLOCKED {FIXED}**; residual hopping with live balances, vote rental, flash proposer → **EXPLOITABLE {ACCEPTED}**; coins printed before the vote → **EXPLOITABLE {PENDING}** |
| `a2b_hopping_scale.ts` | how far the hopping trick scales (10 wallets): round 1 with scan weights, round 2 with live balances | round 1 **BLOCKED {FIXED}**, round 2 **{ACCEPTED}** |
| `a2c_lp_quorum.ts` | quorum base moved by a stranger adding/removing liquidity (no swap fee) | **BLOCKED {FIXED}** |
| `a3_milestones.ts` | milestone payouts: hopping, and flash-holder (buy → snapshot → sell → collect), 3 fund sizes | hopping **BLOCKED {FIXED}**, flash-holder **{ACCEPTED}** |
| `a4_init.ts` | `initialize` squatting / griefing / no parameter bounds / dangerous mint extensions; `register_pool` fee level | **{ACCEPTED}** (decision 2026-09-30: `initialize` stays open, no fee-level check) |
| `a5_competing_pool.ts` | a rival 0.25% pool for the same pair from a public Meteora config | **{PENDING}** — Nikita decides |
| `a6_admin_pause.ts` | single-key powers: pause freezes governance, no admin rotation | **{ACCEPTED}** (one admin) |
| `a7_rogue_owner.ts` | a stolen / dishonest owner key without any vote: milestone fund drain, self-paying SPENDs | **{ACCEPTED}** (single owner address) |
| `a8_position_delegate.ts` | hidden Meteora delegate left on the position before the NFT hand-over | **BLOCKED** (cleared by the hand-over) |
| `a9_cleanup_payroll.ts` | the code v4.1 ADDED: `close_proposal`, `close_voter_snapshot` (who, when, where the rent goes) and the per-role salary record | all attacks **BLOCKED**, controls **OK**, second salary for a new minister **BLOCKED {FIXED}** |
| `inspect_mainnet.ts`, `program_authority.ts`, `meteora_configs.ts`, `inspect_position_nft.ts` | READ-ONLY looks at mainnet / devnet (authorities, Meteora public configs) | data |

Verdict legend: `BLOCKED` the attack failed (good) · `EXPLOITABLE` the attack worked on the real bytecode (a finding) ·
`OK` positive control · `INFO` measurement · `ERROR` the harness failed (look at it).
Status (what was decided): `FIXED` it worked against v4 and v4.1 stops it · `ACCEPTED` it still works and the owner decided to keep it ·
`PENDING` it still works and the decision is not taken yet (launch procedure / Nikita). An `EXPLOITABLE` row **without** a status is unexpected — a regression.
Each run writes `audit/results_*.json`.
