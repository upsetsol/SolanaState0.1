'use strict'

// End-to-end checks of the `onstate` CLI with ONSTATE_SIGNER=okx and a FAKE `onchainos` (local validator, no OKX account).
// Started by run-local.sh AFTER the appoint-wrapper phase: the "OKX wallet" is the wallet that was just appointed culture minister.

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')

const WORK = process.env.E2E_WORK
const RPC = process.env.E2E_RPC || 'http://127.0.0.1:8899'
const MINT = process.env.E2E_MINT
const AGENT = process.env.E2E_AGENT // finance minister (receives a spend in the tests)
const OKX_WALLET = process.env.E2E_OUTSIDER // the culture minister = our "OKX wallet"
const CLI = path.join(__dirname, '..', 'cli', 'bin', 'onstate.js')
const FAKE_OKX = path.join(__dirname, 'fake-onchainos.js')
const HOME_DIR = path.join(WORK, 'home-okx')
const PREVIEWS = path.join(HOME_DIR, '.onstate', 'previews')
const connection = new web3.Connection(RPC, 'confirmed')
fs.mkdirSync(HOME_DIR, { recursive: true })

function env(extra = {}) {
  return {
    ...process.env,
    HOME: HOME_DIR,
    ONSTATE_RPC_URL: RPC,
    ONSTATE_MINT: MINT,
    ONSTATE_SIGNER: 'okx',
    ONSTATE_OKX_BIN: FAKE_OKX,
    FAKE_OKX_KEYPAIR: path.join(WORK, 'outsider.json'),
    FAKE_OKX_RPC: RPC,
    FAKE_OKX_DIR: path.join(WORK, 'fake-okx'),
    ...extra,
  }
}
function cli(args, extra) {
  const r = spawnSync('node', [CLI, ...args], { env: env(extra), encoding: 'utf8', timeout: 150000 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch { /* help text or crash */ }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

const results = []
async function test(name, fn) {
  const t0 = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  } catch (e) {
    results.push({ name, ok: false, error: e })
    console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).split('\n').join('\n        ')}`)
  }
}
const ok = (r, what) => assert.equal(r.json && r.json.success, true, `${what}: expected success, got ${r.stdout || r.stderr}`)
const refused = (r, code, what) => {
  assert.equal(r.json && r.json.success, false, `${what}: expected a refusal, got ${r.stdout}`)
  assert.equal(r.json.code, code, `${what}: expected code ${code}, got ${r.json.code} (${r.json.error})`)
  assert.equal(r.code, 1, `${what}: refusals exit with code 1`)
}
function doAction(args, extra) {
  const p = cli(args, extra)
  ok(p, args[0] + ' preview')
  assert.ok(p.json.requestId, 'preview must carry a requestId')
  const e = cli(['execute', '--request-id', p.json.requestId], extra)
  ok(e, args[0] + ' execute')
  assert.equal(e.json.status, 'BROADCASTED')
  const t = cli(['tx', '--signature', e.json.txHash], extra)
  ok(t, args[0] + ' tx')
  return { preview: p.json, exec: e.json, tx: t.json }
}
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, new web3.PublicKey(owner), true)
const wsol = async (owner) => BigInt((await connection.getTokenAccountBalance(ataOf(owner))).value.amount)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const previewFile = (id) => path.join(PREVIEWS, id + '.json')

async function main() {
  console.log('--- OKX signer ---')
  await test('preflight: ready, with the wallet policy shown', () => {
    const r = cli(['preflight'])
    ok(r, 'preflight')
    assert.equal(r.json.signer, 'okx')
    assert.equal(r.json.address, OKX_WALLET)
    assert.equal(r.json.role, 'culture minister')
    assert.equal(r.json.wallet.policy.singleTxLimit, '5')
    assert.deepEqual(r.json.issues, [])
  })
  await test('preflight: not signed in / CLI missing / wrong state are reported with a fix', () => {
    assert.ok(cli(['preflight'], { FAKE_OKX_LOGGED_IN: '0' }).json.issues.map((i) => i.code).includes('NOT_SIGNED_IN'))
    assert.ok(cli(['preflight'], { ONSTATE_OKX_BIN: '/nonexistent/onchainos' }).json.issues.map((i) => i.code).includes('OKX_NOT_INSTALLED'))
    assert.ok(cli(['preflight'], { ONSTATE_MINT: spl.NATIVE_MINT.toBase58() }).json.issues.map((i) => i.code).includes('STATE_NOT_FOUND'))
    refused(cli(['claim-salary'], { FAKE_OKX_LOGGED_IN: '0' }), 'NOT_SIGNED_IN', 'claim without a login')
  })
  await test('me: the OKX wallet is the culture minister with a salary to claim', () => {
    const r = cli(['me'])
    ok(r, 'me')
    assert.equal(r.json.role, 'culture minister')
    assert.equal(r.json.salary.canClaimNow, true)
    assert.equal(r.json.salary.estimatedPayout, '0.0005 SOL')
    assert.equal(r.json.spendLimits.dailyRemaining, '0.002 SOL')
  })
  await test('claim-salary: preview stores the transaction, execute sends it with a FRESH blockhash', async () => {
    const p = cli(['claim-salary'])
    ok(p, 'preview')
    assert.equal(p.json.role, 'culture minister')
    assert.equal(p.json.expectedPayout, '0.0005 SOL')
    assert.equal(p.json.requireConfirmation, true)
    assert.ok(Array.isArray(p.json.risks))
    const file = previewFile(p.json.requestId)
    assert.ok(fs.existsSync(file), 'the previewed transaction is stored locally')
    const previewHash = web3.VersionedTransaction.deserialize(Buffer.from(JSON.parse(fs.readFileSync(file, 'utf8')).unsignedTx, 'base64')).message.recentBlockhash
    await sleep(2000)
    const before = await wsol(OKX_WALLET).catch(() => 0n)
    const e = cli(['execute', '--request-id', p.json.requestId])
    ok(e, 'execute')
    assert.equal(e.json.status, 'BROADCASTED')
    assert.ok(e.json.txHash)
    const sentHash = fs.readFileSync(path.join(WORK, 'fake-okx', 'last_blockhash.txt'), 'utf8')
    assert.notEqual(sentHash, previewHash, 'execute puts a fresh blockhash into the transaction')
    assert.equal((await wsol(OKX_WALLET)) - before, 500000n)
    assert.equal(fs.existsSync(file), false, 'the stored preview is consumed')
    const t = cli(['tx', '--signature', e.json.txHash])
    ok(t, 'tx')
    assert.ok(t.json.instructions.includes('ClaimSalary'))
    refused(cli(['execute', '--request-id', p.json.requestId]), 'EXECUTE_FAILED', 'a preview can be used once')
  })
  await test('claim-salary again is refused (once per 24 h)', () => refused(cli(['claim-salary']), 'SALARY_TOO_SOON', 'second claim'))
  await test('spend: preview, execute, tx; the recipient gets wSOL; the limit shrinks', async () => {
    const before = await wsol(AGENT).catch(() => 0n)
    const a = doAction(['spend', '--to', AGENT, '--amount', '0.001', '--reason', 'okx spend'])
    assert.equal(a.preview.remainingAfterThisSpend.daily, '0.001 SOL')
    assert.ok(a.tx.instructions.includes('MinisterSpend'))
    assert.equal((await wsol(AGENT)) - before, 1000000n)
    const r = cli(['spend', '--to', AGENT, '--amount', '0.0015', '--reason', 'too much'])
    refused(r, 'EXCEEDS_DAILY_LIMIT', 'over the limit')
    assert.equal(r.json.dailyRemaining, '0.001 SOL')
  })
  await test('OKX asks for an extra confirmation: needsConfirmation, then --force after the human agreed', async () => {
    const extra = { FAKE_OKX_CONFIRM: '1' }
    const p = cli(['spend', '--to', AGENT, '--amount', '0.0005', '--reason', 'needs confirm'], extra)
    ok(p, 'preview')
    const e1 = cli(['execute', '--request-id', p.json.requestId], extra)
    ok(e1, 'execute')
    assert.equal(e1.json.needsConfirmation, true)
    assert.equal(e1.json.txHash, null)
    assert.match(e1.json.message, /confirm/i)
    assert.match(e1.json.next, /--force/)
    const again = cli(['execute', '--request-id', p.json.requestId], extra)
    assert.equal(again.json.needsConfirmation, true, 'without --force it asks again')
    const e2 = cli(['execute', '--request-id', p.json.requestId, '--force'], extra)
    ok(e2, 'execute --force')
    assert.equal(e2.json.status, 'BROADCASTED')
    ok(cli(['tx', '--signature', e2.json.txHash], extra), 'tx')
  })
  await test("OKX's risk scan: 'block' refuses the preview, 'warn' is shown to the human", () => {
    const blocked = cli(['spend', '--to', AGENT, '--amount', '0.0001', '--reason', 'x'], { FAKE_OKX_SCAN_ACTION: 'block' })
    refused(blocked, 'PREVIEW_REJECTED', 'blocked by the scan')
    assert.ok(blocked.json.okx, 'the provider error is passed through under `okx`')
    const warn = cli(['spend', '--to', AGENT, '--amount', '0.0001', '--reason', 'x'], { FAKE_OKX_SCAN_ACTION: 'warn' })
    ok(warn, 'warn preview')
    assert.ok(warn.json.risks.some((x) => x.code === 'TEST_RISK'))
  })
  await test('an old preview (> 10 min) and an unknown id are refused with a recovery hint', () => {
    const p = cli(['spend', '--to', AGENT, '--amount', '0.0001', '--reason', 'old'])
    ok(p, 'preview')
    const file = previewFile(p.json.requestId)
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
    rec.createdAt -= 11 * 60 * 1000
    fs.writeFileSync(file, JSON.stringify(rec))
    const e = cli(['execute', '--request-id', p.json.requestId])
    refused(e, 'EXECUTE_FAILED', 'old preview')
    assert.ok(e.json.hint && /fresh preview/.test(e.json.hint))
    const u = cli(['execute', '--request-id', '00000000-0000-0000-0000-000000000000'])
    refused(u, 'EXECUTE_FAILED', 'unknown id')
    refused(cli(['execute', '--request-id', '../../etc/passwd']), 'EXECUTE_FAILED', 'path tricks are not an id')
  })
  await test('await-approval does not apply to OKX', () => refused(cli(['await-approval']), 'NOT_APPLICABLE', 'await-approval'))
  await test('unwrap: wSOL becomes plain SOL', async () => {
    const before = await connection.getBalance(new web3.PublicKey(OKX_WALLET))
    const a = doAction(['unwrap'])
    assert.ok(a.tx.instructions.includes('CloseAccount'))
    assert.equal(await connection.getAccountInfo(ataOf(OKX_WALLET)), null)
    assert.ok((await connection.getBalance(new web3.PublicKey(OKX_WALLET))) > before)
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed (OKX signer)`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
