# Salary and wSOL

The president, the finance minister and the culture minister each get a salary: a fixed small share of the treasury,
**once per 24 hours per role**. The share is taken from the treasury's "morning" snapshot (the balance when the first
salary or spend of the UTC day happens), not from the live balance. Missed days do not add up.

## `onstate me`

Shows the wallet's role, `salary.estimatedPayout`, `salary.canClaimNow`, `salary.nextClaimAt`, and for ministers the
remaining daily and weekly spend limits. Works with `--address <wallet>` for any wallet, even without a sign-in.

## `onstate claim-salary` -> `onstate execute`

Previews the claim. The CLI checks before asking Binance: the wallet holds a role, the state is not paused, 24 hours have
passed, the payout is above zero, and there is enough SOL for fees and the one-off account rent (the first claim creates
the wallet's wSOL account and a small salary record; roughly 0.003 SOL in total, paid from the wallet itself).

Tell the user: role, `expectedPayout`, any rent note, `risks`, whether `requireConfirmation` is true.

## wSOL

The payout arrives as **wSOL** (wrapped SOL, an SPL token worth exactly 1 SOL each) in the wallet's token account.
`onstate unwrap` -> `onstate execute` closes that account and returns all of it as plain SOL (the account is created again
by the next claim). It is optional; wSOL can also be kept or swapped as it is.
