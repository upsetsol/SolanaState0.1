# On-Chain State agent skill

A **skill** (instructions for an AI agent) plus a small **CLI** (`onstate`) that lets an AI agent work with an On-Chain
State on Solana through the user's **Binance Agentic Wallet**.

```
user  <->  AI agent (Claude Code, Cursor, Codex, ...)  <->  onstate CLI  --unsigned tx-->  baw (Binance)  -->  Solana
                       reads SKILL.md                        reads the chain,              signs and sends
                                                             builds transactions            (key never leaves Binance)
```

- `SKILL.md` + `references/` - what the agent reads: when to use the skill, the command table, the safety rules.
- `cli/` - the `onstate` program (Node >= 18, plain JavaScript). It never holds a key: it builds an *unsigned*
  transaction, dry-runs it, and hands it to `baw contract-call preview --binanceChainId CT_501 --unsignedTx <base64>`.
  After the human says yes, `baw contract-call execute` lets Binance sign and broadcast.
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
| `onstate execute --request-id ID` | sign and send a previewed action (after the human said yes) |
| `onstate await-approval` | wait for the approval in the Binance App |
| `onstate tx --signature S` | wait for a transaction and explain what it did |

Configuration (environment): `ONSTATE_RPC_URL` (default: public mainnet RPC; use your own provider for heavy use),
`ONSTATE_MINT` (the state's coin; default: the live test state "Test 2"), `ONSTATE_PROGRAM`, `ONSTATE_BAW_CHAIN_ID`
(default `CT_501`), `ONSTATE_TX_FORMAT` (`tx` default, or `message`).

## Try it without installing anything

```bash
cd agent-skill/cli && npm install          # once (or rely on the repository's node_modules)
node bin/onstate.js status                 # read-only; works against the live test state
```

## Local test (no Binance, no real money)

```bash
bash agent-skill/test/run-local.sh                # ~5 minutes: starts a local validator, builds a small state,
                                                  # runs agent-skill/test/e2e.js against the CLI with a fake `baw`
E2E_SLOW=1 bash agent-skill/test/run-local.sh     # also checks the stale-blockhash case (+95 s)
```

Needs `solana-test-validator` and `target/deploy/onchain_state_solana.so` (`anchor build`). The fake `baw`
(`test/fake-baw.js`) follows Binance's documented JSON shapes, simulates the transaction on the local validator and signs
with a local key. It does **not** reproduce Binance's real risk engine, blockhash handling or approvals.

## Using it with a real Binance Agentic Wallet

1. In the Binance App create an **Agentic Wallet**, then in its settings turn on **Developer Mode** with a small daily limit.
2. Install `baw` (`npm i -g @binance/agentic-wallet`), run `baw auth signin` and confirm with the QR code.
3. Put about 0.01 SOL on the wallet's Solana address (`baw wallet address`).
4. Run `onstate preflight`. A role (finance / culture minister, president) is needed for `claim-salary` and `spend`;
   roles are given by vote.

## Not verified yet (needs one live test)

Binance's documentation says external signing supports Solana (`--unsignedTx`, base64), but the `baw` client only forwards
the transaction to Binance's server, so these are unknown until a real try:

1. whether the server accepts a transaction for our program (and in which exact byte format);
2. how it deals with Solana's short transaction lifetime (about a minute) when an approval in the App takes longer;
3. whether its risk check blocks an unfamiliar program.

If (2) turns out to be a problem, a "durable nonce" transaction is the usual remedy; if (1) fails on the format, try
`ONSTATE_TX_FORMAT=message`.

## Before publishing

- Publish from a neutral GitHub account in its own public repository (no personal names, paths or emails in files or history).
- Pick a licence (the code here is written fresh; nothing is copied from third-party skills).
- Replace the `install:` entry for `onstate-cli` in `SKILL.md` with the real package source.
- Keep `cli/idl/onchain_state_solana.json` in sync with the deployed program (`idl/` in the main repository).
