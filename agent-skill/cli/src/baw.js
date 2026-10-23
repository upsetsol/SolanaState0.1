'use strict'

// Thin wrapper around Binance's `baw` CLI (Agentic Wallet). `baw` holds the session and does the signing
// (the key lives in Binance's MPC wallet); this CLI only hands it a ready-made, UNSIGNED transaction.

const { execFileSync } = require('node:child_process')
const { CONFIG } = require('./config')
const { CliError } = require('./util')

/** Run `baw ... --json` and parse its output. A failed command that still printed JSON is returned as-is. */
function baw(args) {
  let stdout
  try {
    stdout = execFileSync('baw', [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 << 20, timeout: 120000 })
  } catch (e) {
    if (e.code === 'ENOENT') throw new CliError('BAW_NOT_INSTALLED', 'The Binance Agentic Wallet CLI `baw` is not installed. Install it with: npm i -g @binance/agentic-wallet')
    const text = (e.stdout || '') + (e.stderr || '')
    try {
      return JSON.parse(e.stdout)
    } catch {
      throw new CliError('BAW_FAILED', `baw ${args[0]} failed: ${(text.trim() || e.message).slice(0, 500)}`)
    }
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new CliError('BAW_BAD_OUTPUT', `baw ${args[0]} printed something that is not JSON: ${String(stdout).slice(0, 200)}`)
  }
}

const must = (r, what) => {
  if (!r || !r.success) throw new CliError('BAW_FAILED', `baw ${what} failed`, { error: r && r.error })
  return r.data
}

function bawStatus() {
  const r = baw(['wallet', 'status'])
  return r.success ? r.data.status : 'UNCONNECTED'
}

/** The agentic wallet's address on the configured chain (CT_501 = Solana). */
function bawAddress() {
  const d = must(baw(['wallet', 'address']), 'wallet address')
  const a = (d.addresses || []).find((x) => x.binanceChainId === CONFIG.chainId)
  if (!a) throw new CliError('NO_SOLANA_ADDRESS', `The Agentic Wallet has no address on chain ${CONFIG.chainId}.`)
  return a.address
}

const bawSettings = () => must(baw(['wallet', 'settings']), 'wallet settings')

/** Preview an external Solana transaction through Binance's simulation and risk engine. */
const bawPreview = ({ from, unsignedTx }) =>
  baw(['contract-call', 'preview', '--binanceChainId', CONFIG.chainId, '--from', from, '--unsignedTx', unsignedTx])

const bawExecute = (requestId) => baw(['contract-call', 'execute', '--requestId', requestId])
const bawTxLock = () => baw(['wallet', 'tx-lock', '--binanceChainId', CONFIG.chainId])
const bawTxHistory = (type = 'confirmed', size = '5') =>
  baw(['wallet', 'tx-history', '--type', type, '--size', size, '--binanceChainId', CONFIG.chainId])

module.exports = { baw, bawStatus, bawAddress, bawSettings, bawPreview, bawExecute, bawTxLock, bawTxHistory }
