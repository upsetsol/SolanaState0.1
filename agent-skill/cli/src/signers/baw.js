'use strict'

// Signer: Binance Agentic Wallet (`baw`). Binance previews the transaction on its server (simulation + risk check),
// returns a requestId, and signs/broadcasts it on `execute` (sometimes after an approval in the Binance App).

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const bawCli = require('../baw')
const { CliError, fail, sleep, iso } = require('../util')

const stateDir = () => path.join(os.homedir(), '.onstate')

function newestConfirmedHash() {
  try {
    const r = bawCli.bawTxHistory('confirmed', '3')
    const list = r && r.success && r.data && r.data.transactions
    return list && list.length ? list[0].txHash : null
  } catch {
    return null
  }
}

module.exports = {
  name: 'baw',
  label: 'Binance Agentic Wallet',
  /** the key under which the wallet provider's own error is passed through in our JSON errors */
  errorKey: 'binance',

  /** The wallet's Solana address, or null (read-only commands may work without a wallet). */
  optionalAddress() {
    try {
      return bawCli.bawStatus() === 'CONNECTED' ? bawCli.bawAddress() : null
    } catch {
      return null
    }
  },

  /** The wallet's Solana address; throws when not signed in. */
  address() {
    if (bawCli.bawStatus() !== 'CONNECTED') fail('NOT_SIGNED_IN', 'The Agentic Wallet is not signed in. Run `baw auth signin`, scan the QR code with the Binance App and confirm. Then run `onstate preflight`.')
    return bawCli.bawAddress()
  },

  /** Wallet-side checks for `preflight`. */
  async preflight() {
    const issues = []
    let status = 'UNCONNECTED'
    try {
      status = bawCli.bawStatus()
      if (status !== 'CONNECTED') issues.push({ code: 'NOT_SIGNED_IN', fix: 'Run `baw auth signin`, scan the QR code with the Binance App and confirm.' })
    } catch (e) {
      if (e instanceof CliError) issues.push({ code: e.code, fix: e.message })
      else throw e
    }
    let address = null
    let settings = null
    if (status === 'CONNECTED') {
      try { address = bawCli.bawAddress() } catch (e) { issues.push({ code: e.code || 'NO_SOLANA_ADDRESS', fix: e.message }) }
      try { settings = bawCli.bawSettings() } catch (e) { issues.push({ code: 'SETTINGS_UNAVAILABLE', fix: e.message }) }
      if (settings) {
        const dev = settings.devMode
        if (!dev || !dev.enabled) {
          issues.push({ code: 'DEV_MODE_OFF', fix: 'Turn on Developer Mode in the Binance App: Wallet > Agentic Wallet > settings (top-right corner). Choose a small daily limit.' })
        } else {
          if (dev.expiresAt && Number(dev.expiresAt) * 1000 < Date.now()) issues.push({ code: 'DEV_MODE_EXPIRED', fix: 'Developer Mode has expired. Turn it on again in the Binance App.' })
          if (dev.balanceExceeded) issues.push({ code: 'DEV_MODE_BALANCE_EXCEEDED', fix: "The wallet balance is above Developer Mode's daily limit. Raise the limit in the Binance App or move funds out of the Agentic Wallet." })
        }
      }
    }
    return {
      status,
      address,
      issues,
      wallet: settings && settings.devMode ? { devMode: { enabled: !!settings.devMode.enabled, expiresAt: iso(settings.devMode.expiresAt), dailyLimit: settings.devMode.dailyLimit } } : null,
    }
  },

  /** Binance previews the unsigned transaction (simulation + risk check) and answers with a requestId. */
  async preview({ from, built }) {
    return bawCli.bawPreview({ from, unsignedTx: built.unsignedTx })
  },

  /** Sign + broadcast a previewed request (it may answer PENDING_CONFIRMATION: approve in the Binance App). */
  async execute(requestId) {
    const before = newestConfirmedHash()
    const r = bawCli.bawExecute(requestId)
    if (r.success && r.data && r.data.status === 'PENDING_CONFIRMATION') {
      try {
        fs.mkdirSync(stateDir(), { recursive: true })
        fs.writeFileSync(path.join(stateDir(), 'pending.json'), JSON.stringify({ requestId, newestHashBefore: before, at: Date.now() }))
      } catch { /* best effort */ }
    }
    return r
  },

  /** After PENDING_CONFIRMATION: wait for the approval in the Binance App and find the new transaction. */
  async awaitApproval(opts) {
    const timeout = Math.max(10, Math.min(600, Number(opts.timeout || 240))) * 1000
    let before = null
    try { before = JSON.parse(fs.readFileSync(path.join(stateDir(), 'pending.json'), 'utf8')).newestHashBefore } catch { /* no record */ }
    const start = Date.now()
    let unlockedAt = 0
    for (;;) {
      const lock = bawCli.bawTxLock()
      const state = lock && lock.success && lock.data && lock.data.status
      const newest = newestConfirmedHash()
      if (newest && newest !== before) return { success: true, txHash: newest, next: `onstate tx --signature ${newest}` }
      if (state === 'UNLOCKED') {
        unlockedAt = unlockedAt || Date.now()
        if (Date.now() - unlockedAt > 15000) fail('NOT_APPROVED_OR_EXPIRED', 'The wallet is unlocked but no new transaction appeared: the request was rejected or expired. Run the original command again if the user still wants it.')
      }
      if (Date.now() - start > timeout) fail('TIMEOUT', 'No approval seen yet. Ask the user whether they approved it in the Binance App.')
      await sleep(3000)
    }
  },
}
