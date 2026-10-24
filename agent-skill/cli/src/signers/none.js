'use strict'

// Used when no agent wallet CLI is installed: everything that needs a wallet explains what to install.
const { CliError } = require('../util')

const FIX = 'No agent wallet CLI was found. Install ONE of them: the OKX Agentic Wallet (download the `onchainos` release binary from https://github.com/okx/onchainos-skills/releases, verify its checksum, run `onchainos wallet login`) or the Binance Agentic Wallet (`npm i -g @binance/agentic-wallet`, then `baw auth signin`). See the README of this skill.'
const missing = () => new CliError('NO_WALLET_CLI', FIX)

module.exports = {
  name: 'none',
  label: 'agent wallet',
  errorKey: 'wallet',
  optionalAddress: () => null,
  address() { throw missing() },
  async preflight() { return { status: 'UNCONNECTED', address: null, issues: [{ code: 'NO_WALLET_CLI', fix: FIX }], wallet: null } },
  async preview() { throw missing() },
  async execute() { throw missing() },
  awaitApproval() { throw missing() },
}
