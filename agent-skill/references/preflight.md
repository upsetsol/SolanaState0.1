# Preflight

`onstate preflight` checks everything the other commands depend on, in one call:

- `baw` is installed and signed in (`status: CONNECTED`);
- the Agentic Wallet has a Solana address (chain `CT_501`);
- **Developer Mode** is on, not expired, and the wallet balance is not above its daily limit (external signing of our
  transactions needs it; the user can only change it in the Binance App: Wallet > Agentic Wallet > settings);
- the wallet holds at least about 0.005 SOL (network fees and one-off account rent; 0.01 SOL is comfortable);
- the state exists on the configured network, and which role (if any) this wallet holds.

Output: `success` is true when `issues` is empty. `notes` are information, not problems (your role, a paused state).
Pass every `issues[].fix` to the user as written. Run it first in a session and again after any policy / risk / blocked
error from `baw`.

Settings you cannot change from here: Developer Mode, its daily limit, "Trade all tokens", sign-in duration.
Ask the user to do it in the Binance App and run preflight again.
