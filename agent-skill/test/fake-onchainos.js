#!/usr/bin/env node
'use strict'

// A STAND-IN for the OKX CLI `onchainos`, used ONLY in local tests (no OKX account, no real money).
// It mimics the documented JSON shapes (`{"ok":true,"data":...}`, errors `{"ok":false,"error":...}` with exit 1,
// "confirming" `{"confirming":true,...}` with exit 2) for: wallet status, wallet addresses, security tx-scan and
// wallet contract-call --unsigned-tx <base58>. It signs with a LOCAL key against a LOCAL validator.
// OKX's real server-side behaviour (TEE signing, policy, risk database) is NOT reproduced beyond the knobs below.
//
//   FAKE_OKX_KEYPAIR      path to the "agentic wallet" keypair (required)
//   FAKE_OKX_RPC          local RPC (default http://127.0.0.1:8899)
//   FAKE_OKX_DIR          state dir (default: <tmp>/fake-okx)
//   FAKE_OKX_LOGGED_IN    1 (default) | 0
//   FAKE_OKX_CONFIRM      0 (default) | 1  -> contract-call answers "confirming" (exit 2) until --force is given
//   FAKE_OKX_SCAN_ACTION  "" (default) | warn | block   -> the risk answer of `security tx-scan`

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const bs58 = require('bs58')
const web3 = require('@solana/web3.js')

const argv = process.argv.slice(2)
const kp = web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.FAKE_OKX_KEYPAIR, 'utf8'))))
const connection = new web3.Connection(process.env.FAKE_OKX_RPC || 'http://127.0.0.1:8899', 'confirmed')
const DIR = process.env.FAKE_OKX_DIR || path.join(os.tmpdir(), 'fake-okx')
fs.mkdirSync(DIR, { recursive: true })

const out = (o, code = 0) => { console.log(JSON.stringify(o)); process.exit(code) }
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (line) => fs.appendFileSync(path.join(DIR, 'calls.log'), line + '\n')

const decodeTx = (payload, encoding) =>
  web3.VersionedTransaction.deserialize(encoding === 'base64' ? Buffer.from(payload, 'base64') : Uint8Array.from(bs58.decode(payload)))

async function main() {
  const [a, b] = argv
  log(argv.slice(0, 6).join(' ').slice(0, 140))

  if (a === 'wallet' && b === 'status') {
    return out({ ok: true, data: { accountCount: 1, currentAccountId: 'fake-account', currentAccountName: 'Account 1', email: 'tester@example.invalid', loggedIn: process.env.FAKE_OKX_LOGGED_IN !== '0', loginType: 'email', policy: { singleTxFlag: true, singleTxLimit: '5', dailyTransferTxFlag: false, dailyTransferTxLimit: '', dailyTransferTxUsed: '0', dailyTradeTxFlag: false, dailyTradeTxLimit: '', dailyTradeTxUsed: '0' } } })
  }
  if (a === 'wallet' && b === 'addresses') {
    return out({ ok: true, data: { accountId: 'fake-account', accountName: 'Account 1', bitcoin: [], evm: [], solana: [{ address: kp.publicKey.toBase58(), chainIndex: '501', chainName: 'sol' }], sui: [], xlayer: [] } })
  }

  if (a === 'security' && b === 'tx-scan') {
    if (opt('chain') !== 'solana') return out({ ok: false, error: 'this fake only knows solana' }, 1)
    let vtx
    try { vtx = decodeTx(opt('transactions'), opt('encoding')) } catch { return out({ ok: false, error: 'cannot decode the transaction' }, 1) }
    const sim = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    const action = process.env.FAKE_OKX_SCAN_ACTION || ''
    return out({
      ok: true,
      data: {
        action,
        riskItemDetail: action ? [{ name: 'TEST_RISK', description: { en: 'a test risk item' }, reason: ['injected by the fake'], action }] : [],
        simulator: { gasLimit: null, gasUsed: null, revertReason: sim.value.err ? JSON.stringify({ err: sim.value.err }) : '' },
        warnings: null,
      },
    })
  }

  if (a === 'wallet' && b === 'contract-call') {
    if (opt('chain') !== 'solana') return out({ ok: false, error: 'this fake only knows solana' }, 1)
    if (opt('from') !== kp.publicKey.toBase58()) return out({ ok: false, error: 'from is not the agentic wallet address' }, 1)
    if (!opt('to')) return out({ ok: false, error: '--to is required for a Solana program call' }, 1)
    let vtx
    try { vtx = decodeTx(opt('unsigned-tx'), 'base58') } catch { return out({ ok: false, error: 'cannot decode the base58 unsigned transaction' }, 1) }
    if (!vtx.message.staticAccountKeys[0].equals(kp.publicKey)) return out({ ok: false, error: 'fee payer is not the agentic wallet' }, 1)
    fs.writeFileSync(path.join(DIR, 'last_blockhash.txt'), vtx.message.recentBlockhash)
    if (process.env.FAKE_OKX_CONFIRM === '1' && !argv.includes('--force')) {
      return out({ confirming: true, message: 'OKX asks the user to confirm this contract call (fake).', next: 'If the user confirms, re-run the same command with --force flag appended to proceed.' }, 2)
    }
    vtx.sign([kp])
    let sig
    try {
      sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
    } catch (e) {
      return out({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 1)
    }
    for (let i = 0; i < 60; i++) {
      const st = (await connection.getSignatureStatuses([sig])).value[0]
      if (st && st.err) return out({ ok: false, error: 'transaction failed on chain: ' + JSON.stringify(st.err) }, 1)
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
      await sleep(500)
    }
    return out({ ok: true, data: { txHash: sig, orderId: 'order-' + crypto.randomUUID().slice(0, 8) } })
  }

  return out({ ok: false, error: 'fake onchainos does not know: ' + argv.join(' ') }, 1)
}

main().catch((e) => out({ ok: false, error: 'fake crashed: ' + String((e && e.stack) || e).slice(0, 300) }, 1))
