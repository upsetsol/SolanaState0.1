# On-Chain State agent skill

A **skill** (instructions for an AI agent) plus a small **CLI** (`onstate`) that lets an AI agent work with an On-Chain
State on Solana through the user's **agent wallet**: the **OKX Agentic Wallet** (`onchainos`) or the **Binance Agentic
Wallet** (`baw`). The user just tells the agent "claim my salary"; the agent previews, the user says yes, the wallet signs.

```
user  <->  AI agent (Claude Code, Cursor, Codex, ...)  <->  onstate CLI  --unsigned tx-->  onchainos (OKX) or baw (Binance)  -->  Solana
                       reads SKILL.md                        reads the chain,              signs and sends
                                                             builds transactions            (the key never leaves the provider's enclave / MPC)
```

- `SKILL.md` + `references/` - what the agent reads: when to use the skill, the command table, the safety rules.
- `cli/` - the `onstate` program (Node >= 18, plain JavaScript). It never holds a key: it builds an *unsigned*
  transaction and dry-runs it. Then, per `ONSTATE_SIGNER`:
  - `baw` (Binance, default): `baw contract-call preview --binanceChainId CT_501 --unsignedTx <base64>`; after the human says yes,
    `baw contract-call execute` lets Binance sign and broadcast (sometimes after an approval in the Binance App).
  - `okx`: OKX has no preview call (`wallet contract-call` signs and broadcasts at once), so the preview is ours: build, dry-run,
    OKX's read-only risk scan (`security tx-scan`), store under a request id. After the human says yes, `execute` puts in a fresh
    blockhash, dry-runs again and calls `onchainos wallet contract-call --chain solana --unsigned-tx <base58>`. If OKX asks for an
    extra confirmation (`needsConfirmation`), the human decides and the agent repeats with `--force`.
- `test/` - a local end-to-end test with a **fake `baw`** (no Binance account, no real money).

## Commands

| Command | What it does |
|---|---|
| `onstate preflight` | signed in? Developer Mode? enough SOL? which role? |
| `onstate status` | the state: roles, rules, treasury, proposals (no wallet needed) |
| `onstate me [--address W]` | role, salary estimate, spend limits, coin balance |
| `onstate proposals [--limit N]` | latest proposals, stage, votes, "can I vote" |
| `onstate claim-salary` | preview: claim the role's daily salary |
| `onstate spend --to W --amount SOL --reason "..."` | preview: minister spends within the limits |
| `onstate vote --proposal ID --yes\|--no` | preview: cast a vote |
| `onstate unwrap` | preview: wSOL -> SOL |
| `onstate execute --request-id ID [--force]` | sign and send a previewed action (after the human said yes; `--force` only after a confirmed `needsConfirmation`) |
| `onstate await-approval` | Binance only: wait for the approval in the Binance App |
| `onstate tx --signature S` | wait for a transaction and explain what it did |

Configuration (environment): `ONSTATE_RPC_URL` (default: public mainnet RPC; use your own provider for heavy use),
`ONSTATE_MINT` (the state's coin; default: the live test state "Test 2"), `ONSTATE_PROGRAM`, `ONSTATE_SIGNER` (`baw` default, or
`okx`), `ONSTATE_OKX_BIN` (path of `onchainos`), `ONSTATE_BAW_CHAIN_ID` (default `CT_501`), `ONSTATE_TX_FORMAT` (`tx` default, or `message`).

## Try it without installing anything

```bash
cd agent-skill/cli && npm install          # once (or rely on the repository's node_modules)
node bin/onstate.js status                 # read-only; works against the live test state
```

## Local test (no Binance, no real money)

```bash
bash agent-skill/test/run-local.sh                # ~7 minutes: starts a local validator, builds a small state, runs the CLI with a fake
                                                  # `baw` (e2e.js), the appoint script, and with a fake `onchainos` (e2e-okx.js)
E2E_SLOW=1 bash agent-skill/test/run-local.sh     # also checks the stale-blockhash case (+95 s)
```

Needs `solana-test-validator` and `target/deploy/onchain_state_solana.so` (`anchor build`). The fakes (`test/fake-baw.js`,
`test/fake-onchainos.js`) follow the providers' documented JSON shapes, simulate the transaction on the local validator and sign
with a local key. They do **not** reproduce the providers' real risk engines, blockhash handling or approvals.

## Using it with a real OKX Agentic Wallet

1. Download the `onchainos` release binary for your system from https://github.com/okx/onchainos-skills/releases (for Apple Silicon:
   `onchainos-aarch64-apple-darwin`) and verify it against the release's `checksums.txt` (`shasum -a 256`). `chmod +x` it.
2. `onchainos wallet login` (Google / Apple / email in the browser), then the `completeLogin` command it prints
   (`wallet login --phase poll --session-id ...`). The wallet gets a Solana address (`onchainos wallet addresses --chain solana`).
3. In the OKX web portal (https://web3.okx.com/portfolio/agentic-wallet-policy) set small limits: per transaction, per day, transfer whitelist.
   (A new wallet starts with a per-transaction limit of $5. Whether these limits also apply to program calls is not documented.)
4. Put about 0.01 SOL on that Solana address (fees and one-off account rent). A role (finance / culture minister, president) is needed
   for `claim-salary` and `spend`; roles are given by vote (`scripts/appoint_agent.sh` does it for the owner on the test state).
5. `ONSTATE_SIGNER=okx ONSTATE_OKX_BIN=<path of onchainos> node agent-skill/cli/bin/onstate.js preflight`.

## Using it with a real Binance Agentic Wallet

1. In the Binance App create the keyless wallet; then `npm i -g @binance/agentic-wallet` and `baw auth signin` (QR + pairing code; this
   also creates the Agentic Wallet). In its settings turn on **Developer Mode** with a small daily limit.
2. Put about 0.01 SOL on the wallet's Solana address (`baw wallet address`) and run `onstate preflight`.
(Binance blocked some regions for the keyless wallet - error 300046 - so this path is untested live.)

## Verification status

- Local, fake wallets: all green (`run-local.sh`).
- OKX, live on mainnet (Test 2): `preflight`, `me` and the `claim-salary` preview work, and OKX's server parses our transaction
  (its own simulation and risk scan accept it). The first live `execute` is the remaining check (see CLAUDE.md, item 10).
- Binance: Binance's documentation says external signing supports Solana (`--unsignedTx`, base64), but no live try was possible.

## Before publishing

- Publish from a neutral GitHub account in its own public repository (no personal names, paths or emails in files or history).
- Pick a licence (the code here is written fresh; nothing is copied from third-party skills).
- Replace the `install:` entry for `onstate-cli` in `SKILL.md` with the real package source.
- Keep `cli/idl/onchain_state_solana.json` in sync with the deployed program (`idl/` in the main repository).
