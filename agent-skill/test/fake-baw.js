#!/usr/bin/env node
'use strict'

// A STAND-IN for Binance's `baw` CLI, used ONLY in local tests (no Binance account, no real money).
// It mimics the documented JSON shapes (wallet status / address / settings / tx-lock / tx-history and
// contract-call preview / execute for Solana `--unsignedTx`) and signs with a LOCAL key file against a LOCAL validator.
// Binance's real server-side behaviour (risk engine, blockhash handling, approvals) is NOT reproduced beyond the knobs below.
//
//   FAKE_BAW_KEYPAIR            path to the "agentic wallet" keypair (required)
//   FAKE_BAW_RPC                local RPC (default http://127.0.0.1:8899)
//   FAKE_BAW_DIR                state dir for previews / history (default: <tmp>/fake-baw)
//   FAKE_BAW_STATUS             CONNECTED (default) | UNCONNECTED
//   FAKE_BAW_DEVMODE            on (default) | off | expired | exceeded
//   FAKE_BAW_CONFIRM            0 (default) | 1  -> execute answers PENDING_CONFIRMATION until `fake-baw __approve <requestId>`
//   FAKE_BAW_REFRESH_BLOCKHASH  0 (default) | 1  -> behave like a wallet that swaps in a fresh blockhash before signing
//
// Test-only extra command:  baw __approve --requestId <id>   (plays the human tapping "approve" in the Binance App)

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const web3 = require('@solana/web3.js')

const argv = process.argv.slice(2).filter((a) => a !== '--json')
const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FAKE_BAW_KEYPAIR, 'utf8'))))
const connection = new web3.Connection(process.env.FAKE_BAW_RPC || 'http://127.0.0.1:8899', 'confirmed')
const DIR = process.env.FAKE_BAW_DIR || path.join(os.tmpdir(), 'fake-baw')
fs.mkdirSync(path.join(DIR, 'previews'), { recursive: true })
const HISTORY = path.join(DIR, 'history.json')
const PENDING = path.join(DIR, 'pending.json')

const print = (o) => console.log(JSON.stringify(o))
const ok = (data) => print({ success: true, data })
const err = (code, name, message) => print({ success: false, error: { code, name, message } })
const opt = (name) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : undefined
}
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const log = (line) => fs.appendFileSync(path.join(DIR, 'calls.log'), line + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function signAndSend(preview) {
  const vtx = web3.VersionedTransaction.deserialize(Buffer.from(preview.unsignedTx, 'base64'))
  if (process.env.FAKE_BAW_REFRESH_BLOCKHASH === '1') vtx.message.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  vtx.sign([kp])
  let sig
  try {
    sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 400) }
  }
  for (let i = 0; i < 60; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0]
    if (st && st.err) return { error: 'transaction failed on chain: ' + JSON.stringify(st.err), txHash: sig }
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
    await sleep(500)
  }
  const history = readJson(HISTORY, [])
  history.unshift({ txType: 'contract_call', txHash: sig, status: 'confirmed', binanceChainId: 'CT_501' })
  fs.writeFileSync(HISTORY, JSON.stringify(history))
  return { txHash: sig }
}

async function main() {
  const [a, b] = argv
  log(argv.join(' ').slice(0, 160))

  if (a === 'wallet' && b === 'status') return ok({ status: process.env.FAKE_BAW_STATUS || 'CONNECTED' })
  if (a === 'wallet' && b === 'address') {
    return ok({ addresses: [{ binanceChainId: 'CT_501', address: kp.publicKey.toBase58() }, { binanceChainId: '56', address: '0x000000000000000000000000000000000000dEaD' }] })
  }
  if (a === 'wallet' && b === 'settings') {
    const m = process.env.FAKE_BAW_DEVMODE || 'on'
    const devMode = m === 'off' ? { enabled: false, expiresAt: null, dailyLimit: 0, balanceExceeded: false }
      : { enabled: true, expiresAt: Math.floor(Date.now() / 1000) + (m === 'expired' ? -60 : 86400), dailyLimit: 100, balanceExceeded: m === 'exceeded' }
    return ok({ dailyLimit: 50, tradeAllTokens: false, devMode })
  }
  if (a === 'wallet' && b === 'tx-lock') return ok({ status: fs.existsSync(PENDING) ? 'LOCKED' : 'UNLOCKED' })
  if (a === 'wallet' && b === 'tx-history') {
    const size = Number(opt('size') || 20)
    return ok({ transactions: readJson(HISTORY, []).slice(0, size), hasMore: false, nextCursor: null })
  }

  if (a === 'contract-call' && b === 'preview') {
    if (opt('binanceChainId') !== 'CT_501') return err(1, 'INVALID_PARAMS', 'this fake only knows CT_501')
    if (opt('from') !== kp.publicKey.toBase58()) return err(1, 'INVALID_PARAMS', 'from is not the agentic wallet address')
    const mode = process.env.FAKE_BAW_DEVMODE || 'on'
    if (mode === 'off' || mode === 'expired') return err(351802, 'AGENT_DEV_MODE_DISABLED', 'Developer Mode is not enabled')
    let vtx
    try { vtx = web3.VersionedTransaction.deserialize(Buffer.from(opt('unsignedTx'), 'base64')) } catch (e) { return err(1, 'INVALID_TX', 'cannot parse the unsigned transaction') }
    if (!vtx.message.staticAccountKeys[0].equals(kp.publicKey)) return err(1, 'INVALID_TX', 'fee payer is not the agentic wallet')
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    if (sim.value.err) return err(351805, 'SIMULATION_FAILED', JSON.stringify(sim.value.err))
    const requestId = crypto.randomUUID()
    const requireConfirmation = process.env.FAKE_BAW_CONFIRM === '1'
    fs.writeFileSync(path.join(DIR, 'previews', requestId + '.json'), JSON.stringify({ unsignedTx: opt('unsignedTx'), at: Date.now(), requireConfirmation }))
    return ok({
      requestId,
      parsedTx: { transactionType: 'ContractCall' },
      simulationResult: { simulationCode: '000000000', simulationErrorDetail: null, balanceChanges: [], allowanceChanges: [], authorityChanges: [], preCheckCode: '' },
      risks: { riskDetails: [], addresses: {}, riskBehaviors: [] },
      requireConfirmation,
      expiresAt: Date.now() + 5 * 60 * 1000,
    })
  }

  if (a === 'contract-call' && b === 'execute') {
    const p = path.join(DIR, 'previews', (opt('requestId') || 'none') + '.json')
    const preview = readJson(p, null)
    if (!preview) return err(351820, 'PREVIEW_NOT_FOUND', 'unknown or expired requestId (preview expired)')
    if (Date.now() - preview.at > 5 * 60 * 1000) return err(351820, 'PREVIEW_EXPIRED', 'preview expired')
    if (preview.requireConfirmation) {
      fs.writeFileSync(PENDING, JSON.stringify({ requestId: opt('requestId') }))
      return ok({ orderId: 'order-' + opt('requestId').slice(0, 8), status: 'PENDING_CONFIRMATION', txHash: null, message: 'Please confirm in the Binance App' })
    }
    const r = await signAndSend(preview)
    if (r.error) return err(351830, 'BROADCAST_FAILED', r.error)
    return ok({ orderId: 'order-' + opt('requestId').slice(0, 8), status: 'BROADCASTED', txHash: r.txHash, message: null })
  }

  if (a === '__approve') {
    const pending = readJson(PENDING, null)
    if (!pending) return err(1, 'NOTHING_PENDING', 'no pending order')
    const preview = readJson(path.join(DIR, 'previews', pending.requestId + '.json'), null)
    fs.rmSync(PENDING, { force: true })
    const r = await signAndSend(preview)
    if (r.error) return err(351830, 'BROADCAST_FAILED', r.error)
    return ok({ txHash: r.txHash })
  }

  return err(1, 'UNKNOWN_COMMAND', 'fake baw does not know: ' + argv.join(' '))
}

main().catch((e) => { err(1, 'FAKE_BAW_CRASH', String((e && e.stack) || e).slice(0, 400)); process.exit(1) })
