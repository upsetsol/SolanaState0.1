# Setting up

Read this when `onstate` is missing or `onstate preflight` reports that something is missing.

You may explain these steps and show the commands. **Run an install command only after the user has said yes to that very command.**
Install only from the sources named here; never guess a package name and never pipe a download into a shell.

## 1. The `onstate` command (needs Node.js 18 or newer: check with `node -v`)

```
npm install -g github:{{OWNER}}/{{REPO}}
```

If it stops with `EACCES` (permission denied; common on macOS), the user can give npm a folder of their own, open a new terminal window and repeat:

```
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc
```

Check it with `onstate --version`, then `onstate preflight` (it also lists what else is missing).

## 2. An agent wallet (one of the two)

- **OKX Agentic Wallet:** the user downloads the `onchainos` release binary for their system from
  https://github.com/okx/onchainos-skills/releases, verifies its checksum against `checksums.txt` on the same page (`shasum -a 256 <file>`), makes
  it executable (`chmod +x`) and puts it on the PATH. Then `onchainos wallet login`; the user finishes the login in their own browser and runs the
  `completeLogin` command it prints.
  Limits can be set at https://web3.okx.com/portfolio/agentic-wallet-policy.
- **Binance Agentic Wallet:** `npm install -g @binance/agentic-wallet`, then `baw auth signin` and a QR scan in the Binance app; Developer Mode with a
  small daily limit must be on in the app.

Downloading and running a wallet program is the user's decision and action, not yours.

## 3. A little SOL

About 0.01 SOL on the wallet's Solana address (`onstate preflight` prints it in full) for fees and one-off account rent.

## 4. A role, or a place on a voter list

Salaries are paid only to the president and the two ministers; roles are given by votes of the state's coin holders. To vote, the wallet must hold
the state's coin and the state's owner must have put it on that proposal's voter list before voting opened. Promise nothing and do not
suggest ways around these rules.
