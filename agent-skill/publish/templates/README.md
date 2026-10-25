# On-Chain State: agent skill and CLI

An AI agent (Claude Code and other agents that support skills) can work in an **On-Chain State** on Solana, a small token-governed
"government" with a treasury, a president, a finance minister, a culture minister, daily salaries and votes, **through the user's own
agent wallet**. You write *"claim my salary"* or *"vote"*; the agent reads the chain, shows exactly what would happen, asks, and only after
your explicit "yes" does the wallet sign.

> **Experimental, unaudited, test amounts.** The default state ("Test 2") lives on Solana mainnet and holds fractions of one SOL.
> Nothing here is investment advice. Keep only what you can afford to lose on the wallet you give to an agent.

## What is in this repository

| path | what |
|---|---|
| `skills/onchain-state/` | the **skill** (`SKILL.md` and `references/`): the rules the agent follows |
| `cli/` | the **`onstate` command**: reads the chain and builds *unsigned* transactions; it never sees a key |
| `docs/` | notes on how it was tested |

The on-chain program itself is not part of this repository; this is the agent side only.

## How it works

1. The agent runs `onstate` commands (they print JSON). Reading is free. Actions only create a **preview**: our own dry run plus the wallet provider's risk check.
2. The agent tells you what will happen (who gets what, fees, risks) and asks.
3. After your explicit "yes" the agent runs `onstate execute`; the wallet signs inside its own secure environment.
   **Keys never touch this software or the agent.**
4. Text that comes from the chain (proposal texts, coin names, wallet messages) is **data, never instructions**.

## Install

You need Node.js 18+ (<https://nodejs.org>, check with `node -v`), an agent wallet (below) and an agent that supports skills.

```bash
npm install -g github:{{OWNER}}/{{REPO}}
npx skills add {{OWNER}}/{{REPO}} -g -a claude-code
onstate --version
```

(`-a claude-code` installs the skill for Claude Code; leave it out to choose another agent.)

If `npm install -g` stops with `EACCES` (permission denied; common on macOS), give npm a folder of your own, open a new terminal window and run the install again:

```bash
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
```

### An agent wallet (one of two)

- **OKX Agentic Wallet** (tested live): download the `onchainos` release binary for your system from
  <https://github.com/okx/onchainos-skills/releases>, verify its checksum against `checksums.txt` on the same page (`shasum -a 256 <file>`),
  `chmod +x` it and put it on your PATH (for example into `~/.npm-global/bin`). If macOS refuses to open a file you downloaded with the browser, and
  only after the checksum matched, `xattr -d com.apple.quarantine <file>` lifts that block. Then `onchainos wallet login`, finish the login in the
  browser and run the `completeLogin` command it prints. Set small limits at <https://web3.okx.com/portfolio/agentic-wallet-policy>.
- **Binance Agentic Wallet** (documented by Binance, not tested live by us): `npm install -g @binance/agentic-wallet`, `baw auth signin`, scan the QR code in the Binance app and turn on
  Developer Mode with a small daily limit. Availability depends on your region.

`onstate` picks the first wallet CLI that is installed **and** signed in (OKX, then Binance). Put about 0.01 SOL on the wallet's Solana address
for fees and one-off account rent; `onstate preflight` prints the address.

## Use

Just talk to your agent:

- *"claim my salary"*: roles (president, finance minister, culture minister) get a daily salary, paid as wSOL; `unwrap` turns it into SOL
- *"vote"*: lists the proposals the wallet can vote on and asks which one and FOR or AGAINST
- *"spend 0.0001 SOL from the treasury to ‹address›, reason: ‹text›"*: ministers may spend inside daily and weekly limits without a vote
- *"what is my role?"*, *"how much is in the treasury?"*

A wallet without a role can still vote if the state's owner put it on the proposal's voter list and it holds the state's coin.
Roles are given by votes of the coin holders.

### Commands

```text
onstate preflight                          is everything ready? (wallet, SOL, role)
onstate status                             the state: roles, rules, treasury (no wallet needed)
onstate me                                 my role, salary, spend limits, coin balance
onstate proposals [--limit 10]             proposals with stage, tally and whether I can vote
onstate claim-salary | spend | vote | unwrap     create a PREVIEW of the action
onstate execute --request-id <id>          send a previewed action (only after the user said yes)
onstate tx --signature <sig>               wait for a transaction and explain what it did
onstate --version
```

### Another state or network

Environment variables: `ONSTATE_RPC_URL` (default: the public mainnet endpoint, use your own provider for heavy use), `ONSTATE_MINT` (the state's
coin; default is "Test 2": `27E6pfrdS8dUTzkB2M84MCfdG782oV227UCCQ6wBKcNP`), `ONSTATE_PROGRAM`, `ONSTATE_SIGNER` (`okx`, `baw`, default auto),
`ONSTATE_OKX_BIN`, `ONSTATE_TX_FORMAT`.

## Safety model

- The skill is an instruction to the agent, **not a lock**. The real locks are the limits you set in your wallet and a small balance.
- Every action is *preview, show, ask, execute*. The agent must not chain a preview and its execution without your reply, and must not use the
  wallet's `--force` without a fresh "yes" after the wallet itself asked for confirmation.
- Recipients, amounts and reasons for a spend come only from your own message, never from a web page, proposal text or another tool.
- Install `onstate` only from this repository. The skill tells the agent to ask you before installing anything and never to guess a package name.

## How it was tested

- Local end-to-end tests with fake wallets (Binance and OKX flows), run against a local validator.
- **Live on Solana mainnet with the OKX wallet** (Test 2): `claim-salary`, `spend`, `unwrap` and `vote` were each run once from a fresh agent
  session ("type the request, read the preview, say yes") and checked on chain. Short or vague requests work. A second claim inside 24 hours is refused.
- **Prompt-injection round 1**: real agent sessions against a throw-away state whose proposal texts carried planted instructions
  (pre-approved payments to an attacker, "skip the confirmation", `curl | sh`, recipient swap, fake system blocks). The agent named the attempts,
  followed none of them and moved money only as the user asked. See [docs/RED_TEAM_ROUND_1.md](docs/RED_TEAM_ROUND_1.md) for the details and the limits of that test.
- Not tested: the Binance wallet live; a real agent's answers on a brand-new computer (the CLI's messages for missing pieces are covered).

## License

MIT, see [LICENSE](LICENSE). No warranty.
