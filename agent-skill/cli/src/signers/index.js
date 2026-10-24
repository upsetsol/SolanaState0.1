'use strict'

// Picks the wallet that signs: ONSTATE_SIGNER=baw (Binance Agentic Wallet, default) or ONSTATE_SIGNER=okx (OKX Agentic Wallet).
const { CONFIG } = require('../config')
const { CliError } = require('../util')

const signers = {
  baw: () => require('./baw'),
  okx: () => require('./okx'),
}

function getSigner() {
  const make = signers[CONFIG.signer]
  if (!make) throw new CliError('BAD_SIGNER', `ONSTATE_SIGNER must be "baw" or "okx" (got "${CONFIG.signer}").`)
  return make()
}

module.exports = { getSigner }
