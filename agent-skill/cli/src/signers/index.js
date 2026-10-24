'use strict'

// Picks the wallet that signs.
//   ONSTATE_SIGNER=okx | baw   -> that one
//   ONSTATE_SIGNER=auto (default) -> the first wallet CLI that is installed AND signed in (OKX, then Binance); if none is signed in, the
//   first one that is installed (so `preflight` can say how to sign in); if none is installed, `none` (explains what to install).
const { CONFIG } = require('../config')
const { CliError } = require('../util')

let chosen

function detect() {
  const probe = (name) => {
    try { return require('./' + name).quickState() } catch { return 'missing' }
  }
  const states = { okx: probe('okx'), baw: probe('baw') }
  for (const name of ['okx', 'baw']) if (states[name] === 'ready') return name
  for (const name of ['okx', 'baw']) if (states[name] === 'installed') return name
  return 'none'
}

function getSigner() {
  if (chosen) return chosen
  const want = CONFIG.signer
  if (!['auto', 'okx', 'baw'].includes(want)) throw new CliError('BAD_SIGNER', `ONSTATE_SIGNER must be "auto", "okx" or "baw" (got "${want}").`)
  const name = want === 'auto' ? detect() : want
  chosen = { ...require('./' + name), chosenBy: want === 'auto' ? 'auto-detected' : 'ONSTATE_SIGNER' }
  return chosen
}

module.exports = { getSigner }
