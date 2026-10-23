'use strict'

// End-to-end checks of the `onstate` CLI against a local validator, with a fake `baw`.
// Started by run-local.sh (needs the E2E_* variables it exports). The FIRST tests must run before the open proposal's
// voting window (45 s) ends, so the vote tests come first.

const assert = require('node:assert/strict')
const { spawnSync, spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')

const WORK = process.env.E2E_WORK
const RPC = process.env.E2E_RPC || 'http://127.0.0.1:8899'
const MINT = process.env.E2E_MINT
const AGENT = process.env.E2E_AGENT
const OUTSIDER = process.env.E2E_OUTSIDER
const OWNER = process.env.E2E_OWNER
const VOTE_ID = process.env.E2E_VOTE_PROPOSAL
const SLOW = process.env.E2E_SLOW === '1'
const CLI = path.join(__dirname, '..', 'cli', 'bin', 'onstate.js')
const FAKE = path.join(__dirname, 'fake-baw.js')
const connection = new web3.Connection(RPC, 'confirmed')

function env(extra = {}) {
  return {
    ...process.env,
    PATH: path.join(WORK, 'bin') + path.delimiter + process.env.PATH,
    HOME: path.join(WORK, 'home'),
    ONSTATE_RPC_URL: RPC,
    ONSTATE_MINT: MINT,
    FAKE_BAW_KEYPAIR: path.join(WORK, 'agent.json'),
    FAKE_BAW_RPC: RPC,
    FAKE_BAW_DIR: path.join(WORK, 'fake-baw'),
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
/** preview -> execute (as the human confirmed) -> tx; returns the decoded tx. */
function doAction(args, extra) {
  const p = cli(args, extra)
  ok(p, args[0] + ' preview')
  assert.ok(p.json.requestId, 'preview must carry a requestId')
  assert.ok(p.json.next.includes(p.json.requestId), 'preview must say how to execute')
  const e = cli(['execute', '--request-id', p.json.requestId], extra)
  ok(e, args[0] + ' execute')
  assert.equal(e.json.status, 'BROADCASTED')
  const t = cli(['tx', '--signature', e.json.txHash], extra)
  ok(t, args[0] + ' tx')
  return { preview: p.json, exec: e.json, tx: t.json }
}
const ataOf = (owner) => spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, new web3.PublicKey(owner), true)
const wsolBalance = async (owner) => BigInt((await connection.getTokenAccountBalance(ataOf(owner))).value.amount)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('--- votes (must finish inside the 45 s window) ---')
  await test('proposals: the open proposal shows me as enrolled and not yet voted', () => {
    const r = cli(['proposals'])
    ok(r, 'proposals')
    const p = r.json.proposals.find((x) => String(x.id) === String(VOTE_ID))
    assert.ok(p, 'the vote proposal is listed')
    assert.equal(p.stage, 'VOTING')
    assert.equal(p.you.enrolled, true)
    assert.equal(p.you.alreadyVoted, false)
    assert.equal(p.you.weight, '200000')
  })
  await test('vote --yes: preview, execute, tx; weight is counted', () => {
    const a = doAction(['vote', '--proposal', VOTE_ID, '--yes'])
    assert.equal(a.preview.yourWeight, '200000')
    assert.equal(a.preview.yourVote, 'FOR')
    assert.ok(a.tx.instructions.includes('Vote'), 'the transaction ran the Vote instruction')
    const r = cli(['proposals'])
    const p = r.json.proposals.find((x) => String(x.id) === String(VOTE_ID))
    assert.equal(p.votesFor, '200000')
    assert.equal(p.you.alreadyVoted, true)
  })
  await test('vote again is refused before anything is sent', () => refused(cli(['vote', '--proposal', VOTE_ID, '--yes']), 'ALREADY_VOTED', 'second vote'))
  await test('vote on a missing proposal / without a choice is refused', () => {
    refused(cli(['vote', '--proposal', '999', '--yes']), 'PROPOSAL_NOT_FOUND', 'missing proposal')
    refused(cli(['vote', '--proposal', VOTE_ID]), 'MISSING_ARG', 'no choice')
    refused(cli(['vote', '--proposal', VOTE_ID, '--yes', '--no']), 'MISSING_ARG', 'both choices')
  })
  await test('an outsider (not enrolled) cannot vote', () => {
    const r = cli(['vote', '--proposal', VOTE_ID, '--yes'], { FAKE_BAW_KEYPAIR: path.join(WORK, 'outsider.json') })
    refused(r, 'NOT_ENROLLED', 'outsider vote')
  })

  console.log('--- reading ---')
  await test('status: reads the state', () => {
    const r = cli(['status'])
    ok(r, 'status')
    assert.equal(r.json.governanceCoin.symbol, 'LTS')
    assert.equal(r.json.treasury.balance, '1')
    assert.equal(r.json.roles.financeMinister, AGENT)
    assert.equal(r.json.rules.votingPeriodSecs, 45)
    assert.equal(r.json.proposals, 2)
  })
  await test('preflight: everything ready', () => {
    const r = cli(['preflight'])
    ok(r, 'preflight')
    assert.equal(r.json.address, AGENT)
    assert.equal(r.json.role, 'finance minister')
    assert.deepEqual(r.json.issues, [])
  })
  await test('preflight: reports each problem with a fix', () => {
    const codes = (extra) => cli(['preflight'], extra).json.issues.map((i) => i.code)
    assert.ok(codes({ FAKE_BAW_DEVMODE: 'off' }).includes('DEV_MODE_OFF'))
    assert.ok(codes({ FAKE_BAW_DEVMODE: 'expired' }).includes('DEV_MODE_EXPIRED') || codes({ FAKE_BAW_DEVMODE: 'expired' }).includes('DEV_MODE_OFF'))
    assert.ok(codes({ FAKE_BAW_DEVMODE: 'exceeded' }).includes('DEV_MODE_BALANCE_EXCEEDED'))
    assert.ok(codes({ FAKE_BAW_STATUS: 'UNCONNECTED' }).includes('NOT_SIGNED_IN'))
    const noBaw = cli(['preflight'], { PATH: path.dirname(process.execPath) + path.delimiter + '/usr/bin' + path.delimiter + '/bin' })
    assert.ok(noBaw.json.issues.map((i) => i.code).includes('BAW_NOT_INSTALLED'))
    const wrongMint = cli(['preflight'], { ONSTATE_MINT: spl.NATIVE_MINT.toBase58() })
    assert.ok(wrongMint.json.issues.map((i) => i.code).includes('STATE_NOT_FOUND'))
  })
  await test('me: role, salary estimate and spend limits', () => {
    const r = cli(['me'])
    ok(r, 'me')
    assert.equal(r.json.role, 'finance minister')
    assert.equal(r.json.salary.canClaimNow, true)
    assert.equal(r.json.salary.estimatedPayout, '0.0005 SOL')
    assert.equal(r.json.spendLimits.dailyRemaining, '0.005 SOL')
    assert.equal(r.json.governanceCoin.balance, '200000')
    const o = cli(['me', '--address', OUTSIDER])
    ok(o, 'me --address')
    assert.equal(o.json.role, null)
  })

  console.log('--- salary ---')
  await test('claim-salary: preview, execute, tx; the payout lands as wSOL', async () => {
    const before = await connection.getBalance(new web3.PublicKey(AGENT))
    const a = doAction(['claim-salary'])
    assert.equal(a.preview.expectedPayout, '0.0005 SOL')
    assert.equal(a.preview.role, 'finance minister')
    assert.ok(a.tx.instructions.includes('ClaimSalary'))
    assert.equal(await wsolBalance(AGENT), 500000n)
    assert.ok(before > (await connection.getBalance(new web3.PublicKey(AGENT))), 'the wallet paid fee + rent in SOL')
  })
  await test('claim-salary again is refused (once per 24 h) with the next time', () => {
    const r = cli(['claim-salary'])
    refused(r, 'SALARY_TOO_SOON', 'second claim')
    assert.ok(r.json.nextClaimAt)
  })
  await test('an outsider has no salary and cannot spend', () => {
    const extra = { FAKE_BAW_KEYPAIR: path.join(WORK, 'outsider.json') }
    refused(cli(['claim-salary'], extra), 'NOT_A_ROLE_HOLDER', 'outsider claim')
    refused(cli(['spend', '--to', OWNER, '--amount', '0.001', '--reason', 'x'], extra), 'NOT_A_MINISTER', 'outsider spend')
  })

  console.log('--- minister spend ---')
  await test('spend: preview, execute, tx; the recipient gets wSOL; limits shrink', async () => {
    const a = doAction(['spend', '--to', OUTSIDER, '--amount', '0.001', '--reason', 'e2e spend'])
    assert.equal(a.preview.amount, '0.001 SOL')
    assert.equal(a.preview.recipient, OUTSIDER)
    assert.equal(a.preview.remainingAfterThisSpend.daily, '0.004 SOL')
    assert.ok(a.tx.instructions.includes('MinisterSpend'))
    assert.equal(await wsolBalance(OUTSIDER), 1000000n)
    assert.equal(cli(['me']).json.spendLimits.dailyRemaining, '0.004 SOL')
  })
  await test('spend above the daily limit is refused before anything is sent', () => {
    const r = cli(['spend', '--to', OUTSIDER, '--amount', '0.0045', '--reason', 'too much'])
    refused(r, 'EXCEEDS_DAILY_LIMIT', 'over the limit')
    assert.equal(r.json.dailyRemaining, '0.004 SOL')
  })
  await test('spend: bad input is refused', () => {
    refused(cli(['spend', '--to', OUTSIDER, '--amount', '0.001']), 'MISSING_ARG', 'no reason')
    refused(cli(['spend', '--to', 'not-an-address', '--amount', '0.001', '--reason', 'x']), 'BAD_ADDRESS', 'bad address')
    refused(cli(['spend', '--to', OUTSIDER, '--amount', '1e3', '--reason', 'x']), 'BAD_AMOUNT', 'bad amount')
    refused(cli(['spend', '--to', OUTSIDER, '--amount', '0.001', '--reason', 'x'.repeat(201)]), 'REASON_TOO_LONG', 'long reason')
    refused(cli(['spend', '--to', OUTSIDER, '--amount', '5', '--reason', 'x']), 'INSUFFICIENT_TREASURY', 'more than the treasury')
  })

  console.log('--- Binance behaviours the fake can imitate ---')
  await test('a wallet that swaps in a fresh blockhash before signing still works', async () => {
    const before = await wsolBalance(OUTSIDER)
    doAction(['spend', '--to', OUTSIDER, '--amount', '0.0005', '--reason', 'refresh'], { FAKE_BAW_REFRESH_BLOCKHASH: '1' })
    assert.equal((await wsolBalance(OUTSIDER)) - before, 500000n)
  })
  await test('PENDING_CONFIRMATION: execute waits for the App, await-approval finds the transaction', async () => {
    const extra = { FAKE_BAW_CONFIRM: '1' }
    const p = cli(['spend', '--to', OUTSIDER, '--amount', '0.0005', '--reason', 'needs the app'], extra)
    ok(p, 'preview')
    assert.equal(p.json.requireConfirmation, true)
    const e = cli(['execute', '--request-id', p.json.requestId], extra)
    ok(e, 'execute')
    assert.equal(e.json.pendingConfirmation, true)
    assert.equal(e.json.txHash, null)
    assert.match(e.json.next, /approve/i)
    const waiter = spawn('node', [CLI, 'await-approval', '--timeout', '60'], { env: env(extra), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    waiter.stdout.on('data', (d) => (stdout += d))
    await sleep(4000)
    const approved = spawnSync('node', [FAKE, '__approve'], { env: env(extra), encoding: 'utf8' })
    const sig = JSON.parse(approved.stdout).data.txHash
    await new Promise((res) => waiter.on('close', res))
    const w = JSON.parse(stdout)
    assert.equal(w.success, true, stdout)
    assert.equal(w.txHash, sig)
    ok(cli(['tx', '--signature', sig], extra), 'tx after approval')
  })
  await test('execute with an unknown/expired request id explains how to recover', () => {
    const r = cli(['execute', '--request-id', '00000000-0000-0000-0000-000000000000'])
    refused(r, 'EXECUTE_FAILED', 'unknown request')
    assert.ok(r.json.hint && /fresh preview/.test(r.json.hint))
  })
  await test('a preview whose transaction would fail is refused by our own dry run', () => {
    // vote on the first proposal (already executed): the dry run says so, Binance is never asked
    const r = cli(['vote', '--proposal', '0', '--yes'])
    assert.equal(r.json.success, false)
    assert.ok(['VOTING_NOT_OPEN', 'NOT_ENROLLED'].includes(r.json.code), r.stdout)
  })

  if (SLOW) {
    await test('SLOW: a preview kept too long -> the transaction expires and execute explains it', async () => {
      const p = cli(['spend', '--to', OUTSIDER, '--amount', '0.0005', '--reason', 'stale'])
      ok(p, 'preview')
      console.log('        waiting 95 s for the blockhash to go stale...')
      await sleep(95000)
      const e = cli(['execute', '--request-id', p.json.requestId])
      refused(e, 'EXECUTE_FAILED', 'stale blockhash')
      assert.ok(e.json.hint, 'the error carries a recovery hint: ' + e.stdout)
    })
  }

  console.log('--- unwrap (last: it closes the wSOL account) ---')
  await test('unwrap: wSOL becomes plain SOL', async () => {
    const before = await connection.getBalance(new web3.PublicKey(AGENT))
    const a = doAction(['unwrap'])
    assert.ok(a.tx.instructions.includes('CloseAccount'))
    assert.equal(await connection.getAccountInfo(ataOf(AGENT)), null)
    assert.ok((await connection.getBalance(new web3.PublicKey(AGENT))) > before, 'SOL went up (wSOL + rent back, minus the fee)')
    refused(cli(['unwrap']), 'NOTHING_TO_UNWRAP', 'second unwrap')
  })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
