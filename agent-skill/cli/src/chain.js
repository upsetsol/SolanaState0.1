'use strict'

// Everything that READS the chain and mirrors the program's own rules (so the agent can explain and pre-check
// before anything is sent). Nothing here needs a key.

const anchor = require('@coral-xyz/anchor')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const { CONFIG, IDL } = require('./config')
const { sleep, big, fail } = require('./util')

const { PublicKey, Connection } = web3

const PROGRAM_ID = new PublicKey(CONFIG.program)
const GOV_MINT = new PublicKey(CONFIG.mint)
/** The treasury asset (wSOL / USDC / USDT) is a classic SPL token. */
const TOKEN_PROGRAM = spl.TOKEN_PROGRAM_ID
/** The governance coin is a Token-2022 token. */
const GOV_TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID
const ATA_PROGRAM = spl.ASSOCIATED_TOKEN_PROGRAM_ID
const SECONDS_PER_DAY = 86400
const SECONDS_PER_WEEK = 7 * 86400
/** PROPOSAL_EXEC_WINDOW_SECS in the program: an approved proposal stays executable this long after timelock + fallback. */
const EXEC_WINDOW_SECS = 30 * 86400

const PROPOSAL_TYPES = ['Spend', 'ChangePresident', 'AppointFinanceMinister', 'AppointCultureMinister', 'ChangeParameter', 'ChangeOwner', 'DepositToMilestoneFund']
const PARAM_KEYS = [
  'voting_period_secs', 'proposal_threshold_bps', 'quorum_spend_bps', 'quorum_role_bps', 'quorum_param_bps',
  'finance_daily_bps', 'finance_weekly_bps', 'culture_daily_bps', 'culture_weekly_bps', 'timelock_secs',
  'payroll_president_bps', 'payroll_finance_bps', 'payroll_culture_bps', 'spend_cooldown_secs', 'exec_fallback_secs',
]
const ROLE_LABELS = ['president', 'finance minister', 'culture minister']

// ---------------- flaky public RPCs: repeat a request when the connection is cut ----------------
const TRANSIENT = /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|UND_ERR|other side closed|terminated/i
async function retryFetch(input, init) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(input, init)
      if ((res.status >= 500 || res.status === 429) && i < 5) {
        try { await res.arrayBuffer() } catch { /* drain */ }
        await sleep(800 * (i + 1))
        continue
      }
      return res
    } catch (e) {
      const msg = [e && e.message, e && e.cause && e.cause.message, e && e.cause && e.cause.code, e && e.code].filter(Boolean).join(' ')
      if (i >= 5 || !TRANSIENT.test(msg)) throw e
      await sleep(800 * (i + 1))
    }
  }
}

function makeConnection(url = CONFIG.rpc) {
  return new Connection(url, { commitment: 'confirmed', fetch: retryFetch })
}

/** A read-only Anchor program: the wallet is a dummy because this CLI never signs. */
function loadProgram(connection) {
  const dummy = { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t }
  const provider = new anchor.AnchorProvider(connection, dummy, { commitment: 'confirmed' })
  return new anchor.Program({ ...IDL, address: PROGRAM_ID.toBase58() }, provider)
}

// ---------------- addresses ----------------
const u64le = (n) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n.toString()))
  return b
}
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]
let _config
const configPda = () => (_config = _config || pda([Buffer.from('config'), GOV_MINT.toBuffer()]))
const proposalPda = (id) => pda([Buffer.from('proposal'), configPda().toBuffer(), u64le(id)])
const voterSnapshotPda = (proposal, voter) => pda([Buffer.from('voter_snapshot'), proposal.toBuffer(), voter.toBuffer()])
const spendTrackerPda = (role) => pda([Buffer.from('spend_tracker'), configPda().toBuffer(), Buffer.from([role])])
const payrollPda = (role) => pda([Buffer.from('payroll'), configPda().toBuffer(), Buffer.from([role])])
/** A wallet's account for the treasury asset (salaries and spends arrive here). */
const treasuryAtaOf = (mint, owner) => spl.getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM, ATA_PROGRAM)
/** A wallet's account for the governance coin (vote weight is read from it). */
const govAtaOf = (owner) => spl.getAssociatedTokenAddressSync(GOV_MINT, owner, true, GOV_TOKEN_PROGRAM, ATA_PROGRAM)

// ---------------- reads ----------------
async function readConfig(program) {
  const cfg = await program.account.config.fetchNullable(configPda())
  if (!cfg) fail('STATE_NOT_FOUND', `No state found for coin ${GOV_MINT.toBase58()} under program ${PROGRAM_ID.toBase58()} (check ONSTATE_MINT / ONSTATE_RPC_URL).`)
  return cfg
}

async function treasuryBalance(connection, cfg) {
  try {
    const b = await connection.getTokenAccountBalance(cfg.treasuryTokenAccount, 'confirmed')
    return { raw: BigInt(b.value.amount), decimals: b.value.decimals }
  } catch {
    return { raw: 0n, decimals: 9 }
  }
}

/** The chain's own clock (what the program sees), not the computer's. */
async function chainNow(connection) {
  const info = await connection.getAccountInfo(new PublicKey('SysvarC1ock11111111111111111111111111111111'), 'confirmed')
  return info ? Number(info.data.readBigInt64LE(32)) : Math.floor(Date.now() / 1000)
}

async function mintMeta(connection) {
  const mint = await spl.getMint(connection, GOV_MINT, 'confirmed', GOV_TOKEN_PROGRAM)
  let name = null
  let symbol = null
  try {
    const md = await spl.getTokenMetadata(connection, GOV_MINT, 'confirmed', GOV_TOKEN_PROGRAM)
    if (md) { name = md.name; symbol = md.symbol }
  } catch { /* metadata is optional */ }
  return { decimals: mint.decimals, supply: mint.supply, name, symbol }
}

// ---------------- the program's rules, mirrored for pre-checks ----------------
/** -1 = no role, 0 = president, 1 = finance minister, 2 = culture minister. */
function roleOf(cfg, pk) {
  if (pk.equals(cfg.president)) return 0
  if (pk.equals(cfg.financeMinister)) return 1
  if (pk.equals(cfg.cultureMinister)) return 2
  return -1
}

/** Salaries and minister limits use a once-a-day "morning" snapshot of the treasury (UTC day), not the live balance. */
function snapshotBase(cfg, treasuryRaw, now) {
  const day = Math.floor(now / SECONDS_PER_DAY)
  return Number(cfg.treasurySnapshotDay.toString()) === day ? big(cfg.treasurySnapshotAmount) : treasuryRaw
}

const salaryBps = (cfg, role) => big([cfg.payrollPresidentBps, cfg.payrollFinanceBps, cfg.payrollCultureBps][role])
const ministerBps = (cfg, role) =>
  role === 1 ? { daily: big(cfg.financeDailyBps), weekly: big(cfg.financeWeeklyBps) } : { daily: big(cfg.cultureDailyBps), weekly: big(cfg.cultureWeeklyBps) }

/** Rolling spend windows of a minister's role, as the program would see them right now. */
function trackerNow(tracker, now) {
  let dStart = tracker ? Number(tracker.dailyWindowStart.toString()) : 0
  let dSpent = tracker ? big(tracker.dailySpent) : 0n
  let wStart = tracker ? Number(tracker.weeklyWindowStart.toString()) : 0
  let wSpent = tracker ? big(tracker.weeklySpent) : 0n
  if (now - dStart >= SECONDS_PER_DAY) { dStart = now; dSpent = 0n }
  if (now - wStart >= SECONDS_PER_WEEK) { wStart = now; wSpent = 0n }
  return { dStart, dSpent, wStart, wSpent }
}

const PROPOSAL_STAGE_TEXT = {
  ENROLLING: 'The owner is still enrolling voters; voting is not open yet.',
  VOTING: 'Voting is open.',
  NO_QUORUM: 'Voting ended without a quorum.',
  REJECTED: 'Voting ended and the proposal was rejected.',
  EXPIRED: 'Approved, but it was not executed in time.',
  TIMELOCK: 'Approved; waiting for the timelock to pass before it can be executed.',
  READY: 'Approved and ready to be executed.',
  EXECUTED: 'Executed.',
}

/** Same stages as the website. */
function stageOf(p, cfg, now) {
  const open = !!p.votingOpen
  const deadline = open ? Number(p.deadline.toString()) : 0
  const timelock = Number(cfg.timelockSecs.toString())
  const fallback = Number(cfg.execFallbackSecs.toString())
  const unlock = deadline + timelock
  const expiresAt = open ? unlock + fallback + EXEC_WINDOW_SECS : 0
  const base = open ? big(p.baseAtOpen) : 0n
  const t = p.proposalType
  const qbps = big(t === 0 || t === 6 ? cfg.quorumSpendBps : t <= 3 ? cfg.quorumRoleBps : cfg.quorumParamBps)
  const vf = big(p.votesFor)
  const va = big(p.votesAgainst)
  const quorum = open && (vf + va) * 10000n >= base * qbps
  const passed = vf > va
  let stage
  if (p.executed) stage = 'EXECUTED'
  else if (!open) stage = 'ENROLLING'
  else if (now <= deadline) stage = 'VOTING'
  else if (!quorum) stage = 'NO_QUORUM'
  else if (!passed) stage = 'REJECTED'
  else if (now > expiresAt) stage = 'EXPIRED'
  else if (now < unlock) stage = 'TIMELOCK'
  else stage = 'READY'
  return { stage, text: PROPOSAL_STAGE_TEXT[stage], open, deadline, unlock, quorum, passed, votesFor: vf, votesAgainst: va, secondsToDeadline: open ? deadline - now : null }
}

// ---------------- program errors ----------------
const ERR_BY_CODE = new Map((IDL.errors || []).map((e) => [e.code, e]))
/** simulateTransaction / getTransaction error -> { code, name, message } when it is one of ours. */
function decodeProgramError(err) {
  if (err && err.InstructionError) {
    const [index, e] = err.InstructionError
    if (e && typeof e === 'object' && 'Custom' in e) {
      const info = ERR_BY_CODE.get(e.Custom)
      return { instruction: index, code: e.Custom, name: info ? info.name : undefined, message: info ? info.msg : undefined }
    }
    return { instruction: index, raw: e }
  }
  return { raw: err }
}

module.exports = {
  PROGRAM_ID, GOV_MINT, TOKEN_PROGRAM, GOV_TOKEN_PROGRAM, ATA_PROGRAM,
  SECONDS_PER_DAY, SECONDS_PER_WEEK, PROPOSAL_TYPES, PARAM_KEYS, ROLE_LABELS,
  makeConnection, loadProgram,
  configPda, proposalPda, voterSnapshotPda, spendTrackerPda, payrollPda, treasuryAtaOf, govAtaOf,
  readConfig, treasuryBalance, chainNow, mintMeta,
  roleOf, snapshotBase, salaryBps, ministerBps, trackerNow, stageOf, decodeProgramError,
}
