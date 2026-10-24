# Preflight

`onstate preflight` checks everything the other commands depend on, in one call:

- the wallet CLI is installed and signed in (`status: CONNECTED`): `onchainos` for OKX (`ONSTATE_SIGNER=okx`) or `baw` for Binance;
- the wallet has a Solana address;
- **Binance only: Developer Mode** is on, not expired, and the wallet balance is not above its daily limit (external signing of
  our transactions needs it; the user can only change it in the Binance App: Wallet > Agentic Wallet > settings);
- **OKX only:** the wallet's policy (per-transaction / daily limits) is shown under `wallet.policy`; it is set by the user in the
  OKX web portal;
- the wallet holds at least about 0.005 SOL (network fees and one-off account rent; 0.01 SOL is comfortable);
- the state exists on the configured network, and which role (if any) this wallet holds.

Output: `success` is true when `issues` is empty. `notes` are information, not problems (your role, a paused state).
Pass every `issues[].fix` to the user as written. Run it first in a session and again after any policy / risk / blocked
error from `baw`.

Settings you cannot change from here: Binance's Developer Mode and limits, OKX's policy limits. Ask the user to do it in the
provider's app or website and run preflight again.
