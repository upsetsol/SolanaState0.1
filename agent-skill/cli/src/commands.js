'use strict'

// The commands. Every command prints exactly one JSON document; failures are { success:false, code, error, ... } and exit code 1.
// Money-moving commands never send anything themselves: they build an UNSIGNED transaction, dry-run it, and ask the
// user's Binance Agentic Wallet to PREVIEW it. The agent shows the preview to the human; only after an explicit "yes"
// does `onstate execute` let Binance sign and broadcast.

const anchor = require('@coral-xyz/anchor')
const web3 = require('@solana/web3.js')
const spl = require('@solana/spl-token')
const chain = require('./chain')
const { getSigner } = require('./signers')
const { buildUnsigned, simulate } = require('./build')
const { CONFIG } = require('./config')
const { out, fail, CliError, parseArgs, parseUnits, fmtUnits, big, iso, sleep } = require('./util')

const { PublicKey, SystemProgram } = web3
const MIN_LAMPORTS = 5_000_000n // ~0.005 SOL: enough for fees plus one-off account rents
const LOW_SOL_FIX = 'Send about 0.01 SOL to this address (network fees and one-off account rents).'
/** The wallet that signs (ONSTATE_SIGNER: baw = Binance, okx = OKX); chosen lazily so a bad value becomes a clean error. */
const S = () => getSigner()

// ---------------- shared pieces ----------------
async function context() {
  const connection = chain.makeConnection()
  const program = chain.loadProgram(connection)
  return { connection, program }
}

const unitOf = (cfg) => (cfg.treasuryMint.equals(spl.NATIVE_MINT) ? 'SOL' : 'units of the treasury asset')
const n = (x) => Number(x.toString())

function toPublicKey(text, what) {
  try {
    return new PublicKey(text)
  } catch {
    return fail('BAD_ADDRESS', `${what} is not a valid Solana address: ${text}`)
  }
}

/** The agentic wallet's Solana address (the wallet must be signed in). */
function agentAddress() {
  return new PublicKey(S().address())
}

/** For read-only commands: --address wins, else the agentic wallet if signed in, else null. */
function optionalAddress(opts) {
  if (opts.address) return toPublicKey(opts.address, '--address')
  const a = S().optionalAddress()
  return a ? new PublicKey(a) : null
}

function summarizePreview(p, extra) {
  if (!p.success) fail('PREVIEW_REJECTED', `${S().label} rejected the preview (its code and message are in \`${S().errorKey}\`). Tell the user exactly what it says.`, { step: extra.step, [S().errorKey]: p.error })
  const d = p.data || {}
  const sim = d.simulationResult || {}
  return {
    success: true,
    ...extra,
    requestId: d.requestId,
    expiresAt: d.expiresAt ? new Date(Number(d.expiresAt)).toISOString() : null,
    requireConfirmation: d.requireConfirmation,
    risks: (d.risks && d.risks.riskDetails) || [],
    authorityChanges: sim.authorityChanges || [],
    simulatedChanges: sim.balanceChanges || [],
    next: `onstate execute --request-id ${d.requestId}`,
  }
}

/** Build -> dry-run on our RPC -> the wallet provider's preview. */
async function previewAction({ connection, me, instructions, step, extra }) {
  const built = await buildUnsigned(connection, me, instructions)
  const sim = await simulate(connection, built.vtx)
  if (!sim.ok) {
    const d = sim.decoded || {}
    fail('SIMULATION_FAILED', d.name ? `The program would refuse this: ${d.name} - ${d.message}` : 'The dry run failed.', { step, simulation: { error: d, logs: sim.logs.slice(-6) } })
  }
  const p = await S().preview({ from: me.toBase58(), built })
  let secondsLeft = null
  try {
    const height = await connection.getBlockHeight('confirmed')
    secondsLeft = Math.max(0, Math.round((built.lastValidBlockHeight - height) * 0.4))
  } catch { /* informational only */ }
  return summarizePreview(p, { step, ...extra, transaction: { approxSecondsBeforeItExpires: secondsLeft } })
}

const ataIx = (payer, owner, mint) =>
  spl.createAssociatedTokenAccountIdempotentInstruction(payer, chain.treasuryAtaOf(mint, owner), owner, mint, chain.TOKEN_PROGRAM, chain.ATA_PROGRAM)

async function lamportsOf(connection, pk) {
  return BigInt(await connection.getBalance(pk, 'confirmed'))
}

// ---------------- preflight ----------------
async function preflight() {
  const w = await S().preflight() // wallet-side checks: signed in? address? provider-specific settings
  const issues = [...w.issues]
  const notes = []
  const status = w.status
  const address = w.address

  const { connection, program } = await context()
  let cfg = null
  try {
    cfg = await chain.readConfig(program)
  } catch (e) {
    if (e instanceof CliError) issues.push({ code: e.code, fix: e.message })
    else throw e
  }

  let sol = null
  let role = null
  if (address) {
    const lamports = await lamportsOf(connection, new PublicKey(address))
    sol = fmtUnits(lamports, 9)
    if (lamports < MIN_LAMPORTS) issues.push({ code: 'LOW_SOL', fix: `${LOW_SOL_FIX} Address: ${address}` })
    if (cfg) {
      const r = chain.roleOf(cfg, new PublicKey(address))
      role = r < 0 ? null : chain.ROLE_LABELS[r]
      notes.push(role ? `This wallet is the ${role} of the state.` : 'This wallet holds no role in the state: it can read, and vote if the owner enrolls it, but it cannot claim a salary or spend.')
    }
  }
  if (cfg && cfg.paused) notes.push('The state is PAUSED: salaries, spends and executions are blocked until the admin unpauses it.')

  return {
    success: issues.length === 0,
    signer: S().name,
    signerChosenBy: S().chosenBy,
    status,
    address,
    solBalance: sol,
    role,
    wallet: w.wallet,
    state: { program: chain.PROGRAM_ID.toBase58(), governanceMint: chain.GOV_MINT.toBase58(), found: !!cfg },
    notes,
    issues,
  }
}

// ---------------- status (read-only, no wallet needed) ----------------
async function status() {
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const [meta, tb] = await Promise.all([chain.mintMeta(connection), chain.treasuryBalance(connection, cfg)])
  const pct = (bps) => n(bps) / 100
  const zero = PublicKey.default
  return {
    success: true,
    program: chain.PROGRAM_ID.toBase58(),
    state: chain.configPda().toBase58(),
    governanceCoin: { mint: chain.GOV_MINT.toBase58(), name: meta.name, symbol: meta.symbol, decimals: meta.decimals, supply: fmtUnits(meta.supply, meta.decimals) },
    treasury: { account: cfg.treasuryTokenAccount.toBase58(), asset: cfg.treasuryMint.equals(spl.NATIVE_MINT) ? 'wSOL (SOL)' : cfg.treasuryMint.toBase58(), balance: fmtUnits(tb.raw, tb.decimals) },
    roles: {
      owner: cfg.ownersAuthority.toBase58(),
      admin: cfg.adminAuthority.toBase58(),
      president: cfg.president.toBase58(),
      financeMinister: cfg.financeMinister.equals(zero) ? null : cfg.financeMinister.toBase58(),
      cultureMinister: cfg.cultureMinister.equals(zero) ? null : cfg.cultureMinister.toBase58(),
    },
    rules: {
      votingPeriodSecs: n(cfg.votingPeriodSecs),
      timelockSecs: n(cfg.timelockSecs),
      spendCooldownSecs: n(cfg.spendCooldownSecs),
      executionFallbackSecs: n(cfg.execFallbackSecs),
      proposalThresholdPct: pct(cfg.proposalThresholdBps),
      quorumPct: { spend: pct(cfg.quorumSpendBps), role: pct(cfg.quorumRoleBps), parameter: pct(cfg.quorumParamBps) },
      salaryPctOfTreasuryPerDay: { president: pct(cfg.payrollPresidentBps), financeMinister: pct(cfg.payrollFinanceBps), cultureMinister: pct(cfg.payrollCultureBps) },
      ministerSpendLimitsPctOfTreasury: { financeDaily: pct(cfg.financeDailyBps), financeWeekly: pct(cfg.financeWeeklyBps), cultureDaily: pct(cfg.cultureDailyBps), cultureWeekly: pct(cfg.cultureWeeklyBps) },
      maxSingleSpendPctOfTreasury: 30,
    },
    paused: !!cfg.paused,
    proposals: n(cfg.proposalCount),
    feePoolRegistered: !cfg.feePool.equals(zero),
  }
}

// ---------------- me ----------------
async function me(opts) {
  const addr = optionalAddress(opts)
  if (!addr) fail('NOT_SIGNED_IN', 'No wallet: sign in to the Agentic Wallet (`baw auth signin`) or pass --address <wallet>.')
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const now = await chain.chainNow(connection)
  const [meta, tb, lamports] = await Promise.all([chain.mintMeta(connection), chain.treasuryBalance(connection, cfg), lamportsOf(connection, addr)])

  let coin = 0n
  try {
    coin = BigInt((await connection.getTokenAccountBalance(chain.govAtaOf(addr), 'confirmed')).value.amount)
  } catch { /* no account yet */ }
  let base = meta.supply
  if (!cfg.quorumExcludedAccount.equals(PublicKey.default)) {
    try { base -= BigInt((await connection.getTokenAccountBalance(cfg.quorumExcludedAccount, 'confirmed')).value.amount) } catch { /* ignore */ }
  }

  const r = chain.roleOf(cfg, addr)
  const res = {
    success: true,
    address: addr.toBase58(),
    sol: fmtUnits(lamports, 9),
    governanceCoin: { symbol: meta.symbol, balance: fmtUnits(coin, meta.decimals), votingSharePct: base > 0n ? Number((coin * 10000n) / base) / 100 : 0 },
    role: r < 0 ? null : chain.ROLE_LABELS[r],
  }
  if (r >= 0) {
    const rec = await program.account.payrollClaim.fetchNullable(chain.payrollPda(r))
    const last = rec ? n(rec.lastClaimTs) : 0
    const nextAt = last ? last + chain.SECONDS_PER_DAY : now
    const baseAmt = chain.snapshotBase(cfg, tb.raw, now)
    res.salary = {
      canClaimNow: !cfg.paused && now >= nextAt && baseAmt * chain.salaryBps(cfg, r) / 10000n > 0n,
      nextClaimAt: iso(nextAt),
      estimatedPayout: `${fmtUnits(baseAmt * chain.salaryBps(cfg, r) / 10000n, tb.decimals)} ${unitOf(cfg)}`,
      lastClaimAt: iso(last),
    }
    if (r === 1 || r === 2) {
      const lim = chain.ministerBps(cfg, r)
      const t = chain.trackerNow(await program.account.spendTracker.fetchNullable(chain.spendTrackerPda(r)), now)
      const dCap = (baseAmt * lim.daily) / 10000n
      const wCap = (baseAmt * lim.weekly) / 10000n
      const left = (cap, spent) => (cap > spent ? cap - spent : 0n)
      res.spendLimits = {
        dailyRemaining: `${fmtUnits(left(dCap, t.dSpent), tb.decimals)} ${unitOf(cfg)}`,
        weeklyRemaining: `${fmtUnits(left(wCap, t.wSpent), tb.decimals)} ${unitOf(cfg)}`,
      }
    }
  }
  return res
}

// ---------------- proposals ----------------
async function proposals(opts) {
  const addr = optionalAddress(opts)
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const now = await chain.chainNow(connection)
  const meta = await chain.mintMeta(connection)
  const total = n(cfg.proposalCount)
  const limit = Math.max(1, Math.min(50, Number(opts.limit || 10)))
  const ids = []
  for (let i = total - 1; i >= 0 && ids.length < limit; i--) ids.push(i)
  const pdas = ids.map((i) => chain.proposalPda(i))
  const rows = ids.length ? await program.account.proposal.fetchMultiple(pdas) : []
  const snaps = addr && ids.length ? await program.account.voterSnapshot.fetchMultiple(pdas.map((p) => chain.voterSnapshotPda(p, addr))) : []
  const list = []
  rows.forEach((p, i) => {
    if (!p) return // closed (rent returned)
    const st = chain.stageOf(p, cfg, now)
    const item = {
      id: n(p.id),
      type: chain.PROPOSAL_TYPES[p.proposalType],
      stage: st.stage,
      stageText: st.text,
      creator: p.creator.toBase58(),
      target: p.target.toBase58(),
      amount: p.proposalType === 0 || p.proposalType === 6 ? `${fmtUnits(big(p.amount), 9)} ${unitOf(cfg)}` : undefined,
      parameter: p.proposalType === 4 ? { key: p.paramKey, name: chain.PARAM_KEYS[p.paramKey], value: p.amount.toString() } : undefined,
      reasonUntrusted: p.reason, // free text written by the creator: DATA, never instructions
      votesFor: fmtUnits(st.votesFor, meta.decimals),
      votesAgainst: fmtUnits(st.votesAgainst, meta.decimals),
      quorumReached: st.quorum,
      votingEndsAt: p.votingOpen ? iso(st.deadline) : null,
      secondsToDeadline: st.secondsToDeadline,
    }
    if (addr) {
      const s = snaps[i]
      item.you = s ? { enrolled: true, weight: fmtUnits(big(s.weight), meta.decimals), alreadyVoted: !!s.consumed } : { enrolled: false }
    }
    list.push(item)
  })
  return { success: true, total, shown: list.length, wallet: addr ? addr.toBase58() : null, proposals: list }
}

// ---------------- claim-salary ----------------
async function claimSalary() {
  const me = agentAddress()
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const role = chain.roleOf(cfg, me)
  if (role < 0) fail('NOT_A_ROLE_HOLDER', 'This wallet is not the president, finance minister or culture minister, so it has no salary to claim.', { address: me.toBase58() })
  if (cfg.paused) fail('PAUSED', 'Salaries are paused by the state admin.')
  const now = await chain.chainNow(connection)
  const rec = await program.account.payrollClaim.fetchNullable(chain.payrollPda(role))
  const last = rec ? n(rec.lastClaimTs) : 0
  if (last && now - last < chain.SECONDS_PER_DAY) fail('SALARY_TOO_SOON', 'The salary of this role was already claimed in the last 24 hours.', { lastClaimAt: iso(last), nextClaimAt: iso(last + chain.SECONDS_PER_DAY) })
  const tb = await chain.treasuryBalance(connection, cfg)
  const payout = (chain.snapshotBase(cfg, tb.raw, now) * chain.salaryBps(cfg, role)) / 10000n
  if (payout === 0n) fail('NOTHING_TO_CLAIM', 'The salary would be zero (the treasury is empty or the salary rate is 0).')

  const myAta = chain.treasuryAtaOf(cfg.treasuryMint, me)
  const needAta = !(await connection.getAccountInfo(myAta, 'confirmed'))
  const needRec = !rec
  const rent = (needAta ? BigInt(await connection.getMinimumBalanceForRentExemption(165)) : 0n) + (needRec ? BigInt(await connection.getMinimumBalanceForRentExemption(18)) : 0n)
  const lamports = await lamportsOf(connection, me)
  if (lamports < rent + 10000n) fail('LOW_SOL', `Not enough SOL for fees and the one-off account rent (needs about ${fmtUnits(rent + 10000n, 9)} SOL).`, { address: me.toBase58(), fix: LOW_SOL_FIX })

  const ix = await program.methods
    .claimSalary(role)
    .accounts({
      claimant: me,
      config: chain.configPda(),
      treasuryMint: cfg.treasuryMint,
      payrollClaim: chain.payrollPda(role),
      treasury: cfg.treasuryTokenAccount,
      claimantTokenAccount: myAta,
      tokenProgram: chain.TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return previewAction({
    connection, me, instructions: [ataIx(me, me, cfg.treasuryMint), ix], step: 'claim-salary',
    extra: {
      role: chain.ROLE_LABELS[role],
      expectedPayout: `${fmtUnits(payout, tb.decimals)} ${unitOf(cfg)}`,
      note: `The salary arrives as wSOL in your wallet's token account. ${needAta || needRec ? 'This first claim also creates your token account / salary record (one-off rent about ' + fmtUnits(rent, 9) + ' SOL paid from your wallet). ' : ''}Run \`onstate unwrap\` to turn wSOL into plain SOL.`,
    },
  })
}

// ---------------- spend (minister) ----------------
async function spend(opts) {
  const me = agentAddress()
  const toText = opts.to
  const amountText = opts.amount
  const reason = (opts.reason || '').trim()
  if (!toText || !amountText || !reason) fail('MISSING_ARG', 'spend needs --to <wallet address>, --amount <SOL> and --reason "<text>", all given by the user.')
  if (Buffer.byteLength(reason) > 200) fail('REASON_TOO_LONG', 'The reason may be at most 200 bytes.')
  const to = toPublicKey(toText, '--to')
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const role = chain.roleOf(cfg, me)
  if (role !== 1 && role !== 2) fail('NOT_A_MINISTER', 'Only the finance minister or the culture minister can spend from the treasury without a vote.', { address: me.toBase58() })
  if (cfg.paused) fail('PAUSED', 'Treasury outflows are paused by the state admin.')
  const now = await chain.chainNow(connection)
  const tb = await chain.treasuryBalance(connection, cfg)
  const amount = parseUnits(amountText, tb.decimals)
  if (amount <= 0n) fail('BAD_AMOUNT', 'The amount must be greater than zero.')
  if (amount > tb.raw) fail('INSUFFICIENT_TREASURY', `The treasury holds only ${fmtUnits(tb.raw, tb.decimals)} ${unitOf(cfg)}.`)

  const baseAmt = chain.snapshotBase(cfg, tb.raw, now)
  const lim = chain.ministerBps(cfg, role)
  const t = chain.trackerNow(await program.account.spendTracker.fetchNullable(chain.spendTrackerPda(role)), now)
  const dLeft = (baseAmt * lim.daily) / 10000n - t.dSpent
  const wLeft = (baseAmt * lim.weekly) / 10000n - t.wSpent
  if (amount > dLeft) fail('EXCEEDS_DAILY_LIMIT', 'This spend is above the role\'s daily limit.', { dailyRemaining: `${fmtUnits(dLeft > 0n ? dLeft : 0n, tb.decimals)} ${unitOf(cfg)}` })
  if (amount > wLeft) fail('EXCEEDS_WEEKLY_LIMIT', 'This spend is above the role\'s weekly limit.', { weeklyRemaining: `${fmtUnits(wLeft > 0n ? wLeft : 0n, tb.decimals)} ${unitOf(cfg)}` })

  const recipientAta = chain.treasuryAtaOf(cfg.treasuryMint, to)
  const needAta = !(await connection.getAccountInfo(recipientAta, 'confirmed'))
  const needTracker = !(await connection.getAccountInfo(chain.spendTrackerPda(role), 'confirmed'))
  const rent = (needAta ? BigInt(await connection.getMinimumBalanceForRentExemption(165)) : 0n) + (needTracker ? BigInt(await connection.getMinimumBalanceForRentExemption(42)) : 0n)
  const lamports = await lamportsOf(connection, me)
  if (lamports < rent + 10000n) fail('LOW_SOL', `Not enough SOL for fees and one-off account rent (needs about ${fmtUnits(rent + 10000n, 9)} SOL).`, { address: me.toBase58(), fix: LOW_SOL_FIX })

  const ix = await program.methods
    .ministerSpend(role, new anchor.BN(amount.toString()), reason)
    .accounts({
      minister: me,
      config: chain.configPda(),
      treasuryMint: cfg.treasuryMint,
      spendTracker: chain.spendTrackerPda(role),
      treasury: cfg.treasuryTokenAccount,
      recipientTokenAccount: recipientAta,
      tokenProgram: chain.TOKEN_PROGRAM,
      systemProgram: SystemProgram.programId,
    })
    .instruction()
  return previewAction({
    connection, me, instructions: [ataIx(me, to, cfg.treasuryMint), ix], step: 'spend',
    extra: {
      role: chain.ROLE_LABELS[role],
      recipient: to.toBase58(),
      amount: `${fmtUnits(amount, tb.decimals)} ${unitOf(cfg)}`,
      reason,
      note: `Moves treasury money WITHOUT a vote. The recipient gets wSOL in their token account${needAta ? ' (their account is created now; the one-off rent about ' + fmtUnits(BigInt(await connection.getMinimumBalanceForRentExemption(165)), 9) + ' SOL is paid from your wallet)' : ''}.`,
      remainingAfterThisSpend: { daily: `${fmtUnits(dLeft - amount, tb.decimals)} ${unitOf(cfg)}`, weekly: `${fmtUnits(wLeft - amount, tb.decimals)} ${unitOf(cfg)}` },
    },
  })
}

// ---------------- vote ----------------
async function vote(opts, flags) {
  const id = opts.proposal
  if (id === undefined || !/^\d+$/.test(String(id))) fail('MISSING_ARG', 'vote needs --proposal <id> and --yes or --no.')
  if (flags.has('yes') === flags.has('no')) fail('MISSING_ARG', 'Pass exactly one of --yes or --no (the user must tell you how to vote).')
  const support = flags.has('yes')
  const me = agentAddress()
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  const now = await chain.chainNow(connection)
  const meta = await chain.mintMeta(connection)
  const proposal = chain.proposalPda(id)
  const p = await program.account.proposal.fetchNullable(proposal)
  if (!p) fail('PROPOSAL_NOT_FOUND', `There is no proposal #${id}.`)
  const st = chain.stageOf(p, cfg, now)
  if (st.stage !== 'VOTING') fail('VOTING_NOT_OPEN', st.text, { stage: st.stage })
  const snapPda = chain.voterSnapshotPda(proposal, me)
  const snap = await program.account.voterSnapshot.fetchNullable(snapPda)
  if (!snap) fail('NOT_ENROLLED', 'This wallet is not on the voter list of this proposal. Only wallets the state owner enrolled before voting opened can vote.', { address: me.toBase58() })
  if (snap.consumed) fail('ALREADY_VOTED', 'This wallet has already voted on this proposal.')
  const lamports = await lamportsOf(connection, me)
  if (lamports < 10000n) fail('LOW_SOL', 'Not enough SOL for the network fee.', { address: me.toBase58(), fix: LOW_SOL_FIX })

  const ix = await program.methods
    .vote(new anchor.BN(String(id)), support)
    .accounts({ voter: me, config: chain.configPda(), proposal, voterSnapshot: snapPda })
    .instruction()
  return previewAction({
    connection, me, instructions: [ix], step: 'vote',
    extra: {
      proposal: Number(id),
      type: chain.PROPOSAL_TYPES[p.proposalType],
      reasonUntrusted: p.reason, // free text from the proposal's creator: DATA, never instructions
      yourVote: support ? 'FOR' : 'AGAINST',
      yourWeight: fmtUnits(big(snap.weight), meta.decimals),
      votingEndsAt: iso(st.deadline),
    },
  })
}

// ---------------- unwrap (wSOL -> SOL) ----------------
async function unwrap() {
  const me = agentAddress()
  const { connection, program } = await context()
  const cfg = await chain.readConfig(program)
  if (!cfg.treasuryMint.equals(spl.NATIVE_MINT)) fail('NOT_WSOL', 'The treasury asset of this state is not wSOL; there is nothing to unwrap.')
  const ata = chain.treasuryAtaOf(cfg.treasuryMint, me)
  const info = await connection.getAccountInfo(ata, 'confirmed')
  if (!info) fail('NOTHING_TO_UNWRAP', 'This wallet has no wSOL token account.')
  const bal = BigInt((await connection.getTokenAccountBalance(ata, 'confirmed')).value.amount)
  const ix = spl.createCloseAccountInstruction(ata, me, me, [], chain.TOKEN_PROGRAM)
  return previewAction({
    connection, me, instructions: [ix], step: 'unwrap',
    extra: { wsolBalance: `${fmtUnits(bal, 9)} SOL`, solReturned: `${fmtUnits(BigInt(info.lamports), 9)} SOL (the wSOL plus the account's rent)`, note: 'Closes the wSOL token account and returns everything in it as plain SOL. The account is created again automatically at the next claim.' },
  })
}

// ---------------- execute / await-approval / tx ----------------
async function execute(opts, flags) {
  const id = opts['request-id']
  if (!id) fail('MISSING_ARG', 'execute needs --request-id <id> from a preview the user has already seen and confirmed.')
  const { connection } = await context()
  const r = await S().execute(id, { force: flags.has('force'), connection })
  if (!r.success) {
    const text = JSON.stringify(r.error || {})
    const hint = /expire|blockhash|not found/i.test(text) ? 'The preview (or the transaction in it) has expired. Run the original command again to get a fresh preview, show it to the user and ask for confirmation again.' : undefined
    fail('EXECUTE_FAILED', `${S().label} did not execute the request (its code and message are in \`${S().errorKey}\`).`, { [S().errorKey]: r.error, hint })
  }
  const d = r.data || {}
  if (d.status === 'NEEDS_CONFIRMATION') {
    // the wallet provider wants an extra confirmation from the human: show `message`, and only on a clear yes repeat with --force
    return {
      success: true,
      status: d.status,
      needsConfirmation: true,
      message: d.message,
      txHash: null,
      next: `Show \`message\` to the user. Only if they clearly confirm, run: onstate execute --request-id ${id} --force`,
    }
  }
  const pending = d.status === 'PENDING_CONFIRMATION'
  return {
    success: true,
    status: d.status,
    txHash: d.txHash || null,
    orderId: d.orderId,
    pendingConfirmation: pending,
    next: pending
      ? 'Tell the user to approve the transaction in the Binance App (Wallet > Agentic Wallet), then run `onstate await-approval`. Do NOT run execute again for this request.'
      : d.txHash ? `onstate tx --signature ${d.txHash}` : undefined,
  }
}

const TOKEN_IX_NAMES = { 1: 'InitializeAccount', 3: 'Transfer', 9: 'CloseAccount', 12: 'TransferChecked', 17: 'SyncNative', 18: 'InitializeAccount3' }

/** Plain SPL Token / associated-token instructions often leave no "Instruction:" line in the logs (unwrap is one), so name them from the message. */
function splInstructionNames(message, keys) {
  const names = []
  for (const ix of message.compiledInstructions || []) {
    const program = keys[ix.programIdIndex]
    const first = ix.data && ix.data.length ? ix.data[0] : 0
    if (program.equals(chain.TOKEN_PROGRAM) && TOKEN_IX_NAMES[first]) names.push(TOKEN_IX_NAMES[first])
    else if (program.equals(spl.ASSOCIATED_TOKEN_PROGRAM_ID)) names.push(first === 1 ? 'CreateIdempotent' : 'Create')
  }
  return names
}

async function txCommand(opts) {
  const sig = opts.signature || opts.hash
  if (!sig) fail('MISSING_ARG', 'tx needs --signature <transaction signature>.')
  const { connection } = await context()
  const deadline = Date.now() + 90000
  let st
  for (;;) {
    const r = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true })
    st = r.value[0]
    if (st && (st.err || st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) break
    if (Date.now() > deadline) fail('TX_NOT_FOUND', 'The transaction did not show up on chain within 90 seconds. It may have expired without landing; check again later or repeat the action.', { signature: sig })
    await sleep(2000)
  }
  const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
  if (!t) fail('TX_NOT_FOUND', 'The transaction is confirmed but its details are not available yet; try again in a few seconds.', { signature: sig })
  const keys = t.transaction.message.staticAccountKeys || t.transaction.message.accountKeys
  const payer = keys[0]
  const meta = t.meta
  const idx = new Map()
  const bump = (list, sign) => (list || []).forEach((b) => {
    if (b.owner !== payer.toBase58()) return
    const cur = idx.get(b.accountIndex) || { mint: b.mint, decimals: b.uiTokenAmount.decimals, delta: 0n }
    cur.delta += sign * BigInt(b.uiTokenAmount.amount)
    idx.set(b.accountIndex, cur)
  })
  bump(meta.postTokenBalances, 1n)
  bump(meta.preTokenBalances, -1n)
  const tokenChanges = [...idx.values()].filter((c) => c.delta !== 0n).map((c) => ({ mint: c.mint, change: fmtUnits(c.delta, c.decimals) }))
  const logged = (meta.logMessages || []).filter((l) => l.startsWith('Program log: Instruction:')).map((l) => l.replace('Program log: Instruction: ', ''))
  const instructions = logged.length ? logged : splInstructionNames(t.transaction.message, keys)
  const ok = !meta.err
  return {
    success: ok,
    signature: sig,
    confirmation: st.confirmationStatus || null,
    ...(ok ? {} : { code: 'TX_FAILED', error: 'The transaction landed but failed.', programError: chain.decodeProgramError(meta.err) }),
    feePayer: payer.toBase58(),
    feeSol: fmtUnits(BigInt(meta.fee), 9),
    solChange: fmtUnits(BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0]), 9),
    tokenChanges,
    instructions,
    explorer: /localhost|127\.0\.0\.1/.test(CONFIG.rpc) ? undefined : `https://solscan.io/tx/${sig}`,
  }
}

// ---------------- dispatcher ----------------
const HELP = `onstate - agent CLI for an On-Chain State on Solana (signing is done by the user's agent wallet: Binance via \`baw\` or OKX via \`onchainos\`)

  onstate preflight                          is everything ready? (wallet signed in, wallet settings, SOL, role)
  onstate status                             the state: roles, rules, treasury, proposals (no wallet needed)
  onstate me [--address <wallet>]            my role, salary and spend limits, coin balance
  onstate proposals [--limit 10]             latest proposals with stage, votes and whether I can vote
  onstate claim-salary                       preview: claim my role's daily salary
  onstate spend --to <wallet> --amount <SOL> --reason "<text>"
                                             preview: minister spends treasury money without a vote (limits apply)
  onstate vote --proposal <id> (--yes | --no)  preview: cast my vote
  onstate unwrap                             preview: turn my wSOL into plain SOL
  onstate execute --request-id <id> [--force]  sign and send a previewed action (ONLY after the user said yes; --force only after
                                             a needsConfirmation answer that the user confirmed)
  onstate await-approval [--timeout 240]     (Binance only) after execute returned pendingConfirmation: wait for the App approval
  onstate tx --signature <sig>               wait for a transaction and explain what it did

env: ONSTATE_RPC_URL, ONSTATE_MINT (default: ${CONFIG.mint}), ONSTATE_PROGRAM, ONSTATE_SIGNER (auto = the first installed and signed-in wallet, okx, baw; now: ${CONFIG.signer}),
     ONSTATE_OKX_BIN, ONSTATE_BAW_CHAIN_ID (default ${CONFIG.chainId}), ONSTATE_TX_FORMAT`

/** The version of this package: the root package.json of the published repository, or cli/package.json in the development tree. */
function packageVersion() {
  for (const p of ['../../package.json', '../package.json']) {
    try {
      const j = require(p)
      if (j && j.name === 'onstate-cli') return j.version
    } catch { /* try the next location */ }
  }
  return 'unknown'
}

async function run(argv) {
  const { cmd, opts, flags } = parseArgs(argv)
  if (cmd === 'version' || flags.has('version') || argv[0] === '-v') {
    out({ success: true, name: 'onstate-cli', version: packageVersion() })
    return
  }
  try {
    let result
    switch (cmd) {
      case 'preflight': result = await preflight(); break
      case 'status': result = await status(); break
      case 'me': result = await me(opts); break
      case 'proposals': result = await proposals(opts); break
      case 'claim-salary': result = await claimSalary(); break
      case 'spend': result = await spend(opts); break
      case 'vote': result = await vote(opts, flags); break
      case 'unwrap': result = await unwrap(); break
      case 'execute': result = await execute(opts, flags); break
      case 'await-approval': result = await S().awaitApproval(opts); break
      case 'tx': result = await txCommand(opts); break
      default:
        console.log(HELP)
        process.exitCode = cmd ? 1 : 0
        return
    }
    out(result)
    // a landed-but-failed transaction is a failure too; preflight reports problems in its JSON and keeps exit code 0
    if (cmd !== 'preflight' && result && result.success === false) process.exitCode = 1
  } catch (e) {
    if (e instanceof CliError) {
      out({ success: false, code: e.code, error: e.message, ...e.extra })
    } else {
      out({ success: false, code: 'UNEXPECTED', error: String((e && e.message) || e).slice(0, 600) })
    }
    process.exitCode = 1
  }
}

module.exports = { run }
