// Full end-to-end scenario suite against a live cluster (devnet or local).
// Self-contained: creates the mint, initialises with ultra-short windows,
// funds 3 holders, then runs every governance / money / milestone / negative
// path and prints a PASS/FAIL table.
//
//   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-node scripts/e2e.ts
//
// Needs ~2 devnet SOL beyond the program deploy. Total run ~4-6 min (waits).

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedWithFeeInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const WALLET = (process.env.ANCHOR_WALLET || "~/.config/solana/id.json").replace("~", os.homedir());
const IDL = JSON.parse(fs.readFileSync("./target/idl/onchain_state_solana.json", "utf8"));
const PROGRAM_ID = new PublicKey(IDL.address);
const TP = TOKEN_2022_PROGRAM_ID;
const ATAP = ASSOCIATED_TOKEN_PROGRAM_ID;
const DEC = 9;
const FEE_BPS = 500;

const results: { name: string; ok: boolean; note?: string }[] = [];
function record(name: string, ok: boolean, note?: string) {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? "  — " + note : ""}`);
}
async function expectErr(name: string, code: string, fn: () => Promise<any>) {
  try {
    await fn();
    record(name, false, `expected ${code}, but it succeeded`);
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message ?? String(e);
    record(name, msg === code, `got ${msg}`);
  }
}
async function expectOk(name: string, fn: () => Promise<any>) {
  try {
    await fn();
    record(name, true);
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message ?? String(e);
    record(name, false, msg);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Congested networks (public testnet) drop transactions: resend with a fresh blockhash
// when one expires. Applies to every anchor `.rpc()` and to sendAndConfirmTransaction.
const EXPIRED = /expired|block height exceeded|Blockhash not found|blockhash not found/i;
const origSendAndConfirm = (anchor.AnchorProvider.prototype as any).sendAndConfirm;
(anchor.AnchorProvider.prototype as any).sendAndConfirm = async function (this: any, ...args: any[]) {
  for (let i = 0; ; i++) {
    try {
      return await origSendAndConfirm.apply(this, args);
    } catch (e: any) {
      if (i < 6 && EXPIRED.test(String(e?.message ?? e))) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
};
async function sendRetry(c: Connection, tx: Transaction, signers: Keypair[], opts: any) {
  for (let i = 0; ; i++) {
    try {
      return await sendAndConfirmTransaction(c, tx, signers, opts);
    } catch (e: any) {
      if (i < 6 && EXPIRED.test(String(e?.message ?? e))) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}
// Flaky networks (public RPCs, sandboxes) reset connections: retry transport errors.
async function retryFetch(input: any, init?: any): Promise<any> {
  let last: any;
  for (let i = 0; i < 8; i++) {
    try {
      return await fetch(input, init);
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
}
const conn = new Connection(RPC, { commitment: "confirmed", fetch: retryFetch as any });
async function chainNow() {
  const s = await conn.getSlot();
  return (await conn.getBlockTime(s)) ?? Math.floor(Date.now() / 1000);
}
async function waitChain(target: number) {
  for (;;) {
    const n = await chainNow();
    if (n >= target) return;
    process.stdout.write(`  …wait ${target - n}s\r`);
    await sleep(Math.min((target - n) * 1000, 5000));
  }
}

function u64(n: any) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n.toString()));
  return b;
}

async function main() {
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(WALLET, "utf8"))));
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL, provider) as any;
  const me = payer.publicKey;
  console.log("Deployer / owners / admin / president:", me.toBase58());
  console.log("Program:", PROGRAM_ID.toBase58(), "\n");

  // ---------- mint ----------
  const mint = Keypair.generate();
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config"), mint.publicKey.toBuffer()],
    PROGRAM_ID
  );
  const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
  const mintRent = await conn.getMinimumBalanceForRentExemption(mintLen);
  const myAta = getAssociatedTokenAddressSync(mint.publicKey, me, false, TP, ATAP);
  const SUPPLY = 1_000_000_000n * 10n ** BigInt(DEC);
  await sendRetry(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: me,
        newAccountPubkey: mint.publicKey,
        space: mintLen,
        lamports: mintRent,
        programId: TP,
      }),
      createInitializeTransferFeeConfigInstruction(
        mint.publicKey,
        null, // tax frozen forever, like prod
        configPda,
        FEE_BPS,
        BigInt("18446744073709551615"),
        TP
      ),
      createInitializeMintInstruction(mint.publicKey, DEC, me, null, TP),
      createAssociatedTokenAccountIdempotentInstruction(me, myAta, me, mint.publicKey, TP, ATAP),
      createMintToInstruction(mint.publicKey, myAta, me, SUPPLY, [], TP)
    ),
    [payer, mint],
    { commitment: "confirmed" }
  );
  record("create mint (Token-2022 + 5% fee, withheld auth = Config PDA)", true, mint.publicKey.toBase58());

  const treasury = getAssociatedTokenAddressSync(mint.publicKey, configPda, true, TP, ATAP);
  const [milestoneFundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("milestone_fund"), configPda.toBuffer()],
    PROGRAM_ID
  );
  const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, o, false, TP, ATAP);
  const proposalPda = (id: any) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("proposal"), configPda.toBuffer(), u64(id)],
      PROGRAM_ID
    )[0];
  const snapPda = (p: PublicKey, v: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("voter_snapshot"), p.toBuffer(), v.toBuffer()],
      PROGRAM_ID
    )[0];
  const trackerPda = (role: number) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("spend_tracker"), configPda.toBuffer(), Buffer.from([role])],
      PROGRAM_ID
    )[0];
  const milestonePda = (n: any) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("milestone"), configPda.toBuffer(), u64(n)],
      PROGRAM_ID
    )[0];
  const mSnapPda = (m: PublicKey, h: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("milestone_snap"), m.toBuffer(), h.toBuffer()],
      PROGRAM_ID
    )[0];
  const bal = async (a: PublicKey) => {
    try {
      return (await getAccount(conn, a, "confirmed", TP)).amount;
    } catch {
      return -1n;
    }
  };

  // ---------- initialize (ultra-short windows) ----------
  const VOTE = 14,
    TL = 7,
    COOL = 10,
    FB = 6,
    GRACE = 8;
  await expectOk("initialize", () =>
    program.methods
      .initialize(
        me, // owners
        me, // admin
        me, // president
        new anchor.BN(VOTE),
        new anchor.BN(100), // threshold 1%
        new anchor.BN(300), // quorum spend 3%
        new anchor.BN(1000), // quorum role 10%
        new anchor.BN(1500), // quorum param 15%
        new anchor.BN(50), // finance daily 0.5%
        new anchor.BN(150), // finance weekly 1.5%
        new anchor.BN(20),
        new anchor.BN(50),
        new anchor.BN(TL),
        new anchor.BN(10), // payroll pres 0.1%
        new anchor.BN(5),
        new anchor.BN(5),
        new anchor.BN(25), // citizenship 0.25%
        new anchor.BN(1000), // milestone deposit 10%
        new anchor.BN(COOL),
        new anchor.BN(FB),
        new anchor.BN(GRACE)
      )
      .accounts({
        owner: me,
        governanceMint: mint.publicKey,
        config: configPda,
        treasury,
        tokenProgram: TP,
        associatedTokenProgram: ATAP,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  await expectOk("setup_milestone_fund", () =>
    program.methods
      .setupMilestoneFund()
      .accounts({
        owner: me,
        governanceMint: mint.publicKey,
        config: configPda,
        milestoneFund: milestoneFundPda,
        tokenProgram: TP,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  // ---------- holders ----------
  const holders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const labels = ["A", "B", "C"];
  // fund SOL + create ATAs + distribute tokens (A big, B mid, C small)
  const amts = [200_000_000n, 60_000_000n, 2_000_000n].map((x) => x * 10n ** BigInt(DEC)); // 20% / 6% / 0.2%
  {
    const tx = new Transaction();
    for (const h of holders)
      tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: h.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    await sendRetry(conn, tx, [payer], { commitment: "confirmed" });
  }
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const hAta = ata(h.publicKey);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(me, hAta, h.publicKey, mint.publicKey, TP, ATAP),
      createTransferCheckedWithFeeInstruction(
        myAta,
        mint.publicKey,
        hAta,
        me,
        amts[i],
        DEC,
        (amts[i] * BigInt(FEE_BPS)) / 10_000n,
        [],
        TP
      )
    );
    await sendRetry(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  holder ${labels[i]} ${h.publicKey.toBase58()} balance ${await bal(hAta)}`);
  }
  record("distribute tokens to 3 holders (tax applied on transfer)", true);

  const progFor = (kp: Keypair) =>
    new anchor.Program(
      IDL,
      new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })
    ) as any;

  // helper: create + snapshot voters + vote
  async function propose(type: number, target: PublicKey, amount: any, paramKey: number, reason: string) {
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.proposalCount;
    const pPda = proposalPda(id);
    await program.methods
      .createProposal(type, target, new anchor.BN(amount.toString()), paramKey, reason)
      .accounts({
        creator: me,
        governanceMint: mint.publicKey,
        creatorTokenAccount: myAta,
        config: configPda,
        treasury,
        proposal: pPda,
        tokenProgram: TP,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { id, pPda };
  }
  async function snapshot(id: any, pPda: PublicKey, voter: PublicKey) {
    await program.methods
      .postVoterSnapshot(new anchor.BN(id.toString()), voter)
      .accounts({
        owner: me,
        config: configPda,
        proposal: pPda,
        voterTokenAccount: ata(voter),
        voterSnapshot: snapPda(pPda, voter),
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
  async function vote(kp: Keypair, id: any, pPda: PublicKey, support: boolean) {
    await progFor(kp)
      .methods.vote(new anchor.BN(id.toString()), support)
      .accounts({ voter: kp.publicKey, config: configPda, proposal: pPda, voterSnapshot: snapPda(pPda, kp.publicKey) })
      .rpc();
  }
  async function execute(id: any, opts: { recipient?: PublicKey; milestoneFund?: boolean } = {}) {
    await program.methods
      .executeProposal(new anchor.BN(id.toString()))
      .accounts({
        executor: me,
        governanceMint: mint.publicKey,
        config: configPda,
        proposal: proposalPda(id),
        treasury,
        recipientTokenAccount: opts.recipient ?? null,
        milestoneFund: opts.milestoneFund ? milestoneFundPda : null,
        tokenProgram: TP,
      })
      .rpc();
  }
  async function deadlineOf(pPda: PublicKey) {
    return Number((await program.account.proposal.fetch(pPda)).deadline.toString());
  }

  // ===== SPEND happy path + cooldown =====
  {
    // Treasury only fills from tax/harvest. Seed it with a taxed transfer.
    const seed = 100_000_000n * 10n ** BigInt(DEC);
    await sendRetry(
      conn,
      new Transaction().add(
        createTransferCheckedWithFeeInstruction(
          myAta, mint.publicKey, treasury, me, seed, DEC, (seed * BigInt(FEE_BPS)) / 10_000n, [], TP
        )
      ),
      [payer],
      { commitment: "confirmed" }
    );
    const tBefore = await bal(treasury);

    // Two SPEND proposals created + voted up front, so the second is ready to
    // execute the instant the first one does (to actually hit the cooldown).
    const p1 = await propose(0, holders[0].publicKey, 10_000_000n * 10n ** BigInt(DEC), 0, "spend #1");
    await snapshot(p1.id, p1.pPda, holders[0].publicKey);
    await snapshot(p1.id, p1.pPda, holders[1].publicKey);
    await vote(holders[0], p1.id, p1.pPda, true);
    await vote(holders[1], p1.id, p1.pPda, true);
    await expectErr("snapshot after voting started → VotingAlreadyStarted", "VotingAlreadyStarted", () =>
      snapshot(p1.id, p1.pPda, holders[2].publicKey)
    );

    const p2 = await propose(0, holders[0].publicKey, 1_000_000n * 10n ** BigInt(DEC), 0, "spend #2");
    await snapshot(p2.id, p2.pPda, holders[0].publicKey);
    await snapshot(p2.id, p2.pPda, holders[1].publicKey);
    await vote(holders[0], p2.id, p2.pPda, true);
    await vote(holders[1], p2.id, p2.pPda, true);

    await waitChain(Math.max(await deadlineOf(p1.pPda), await deadlineOf(p2.pPda)) + TL + 2);

    await expectErr("execute by non-owner → NotOwner", "NotOwner", () =>
      progFor(holders[0])
        .methods.executeProposal(new anchor.BN(p1.id.toString()))
        .accounts({
          executor: holders[0].publicKey,
          governanceMint: mint.publicKey,
          config: configPda,
          proposal: p1.pPda,
          treasury,
          recipientTokenAccount: ata(holders[0].publicKey),
          milestoneFund: null,
          tokenProgram: TP,
        })
        .rpc()
    );
    await expectOk("execute SPEND #1 (owner)", () => execute(p1.id, { recipient: ata(holders[0].publicKey) }));
    const tAfter = await bal(treasury);
    record("SPEND moved treasury tokens", tAfter < tBefore, `${tBefore} → ${tAfter}`);

    await expectErr("2nd SPEND inside cooldown → SpendCooldown", "SpendCooldown", () =>
      execute(p2.id, { recipient: ata(holders[0].publicKey) })
    );
    await waitChain((await chainNow()) + COOL + 2);
    await expectOk("SPEND #2 after cooldown elapsed", () => execute(p2.id, { recipient: ata(holders[0].publicKey) }));
  }

  // ===== negative: below threshold / spend cap =====
  {
    const nextId = (await program.account.config.fetch(configPda)).proposalCount;
    await expectErr("create SPEND from tiny holder → BelowThreshold", "BelowThreshold", () =>
      progFor(holders[2])
        .methods.createProposal(0, holders[2].publicKey, new anchor.BN("1000000000"), 0, "nope")
        .accounts({
          creator: holders[2].publicKey,
          governanceMint: mint.publicKey,
          creatorTokenAccount: ata(holders[2].publicKey),
          config: configPda,
          treasury,
          proposal: proposalPda(nextId),
          tokenProgram: TP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }
  {
    const t = await bal(treasury);
    await expectErr("create SPEND > 30% cap → ExceedsSpendCap", "ExceedsSpendCap", () =>
      propose(0, holders[0].publicKey, ((t as bigint) * 4n) / 10n, 0, "too big")
    );
  }

  // ===== quorum not reached =====
  {
    const { id, pPda } = await propose(0, holders[0].publicKey, 1n * 10n ** BigInt(DEC), 0, "quorum test");
    await snapshot(id, pPda, holders[2].publicKey); // only tiny holder
    await vote(holders[2], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectErr("execute below quorum → QuorumNotReached", "QuorumNotReached", () =>
      execute(id, { recipient: ata(holders[0].publicKey) })
    );
  }

  // ===== majority rejected =====
  {
    const { id, pPda } = await propose(0, holders[0].publicKey, 1n * 10n ** BigInt(DEC), 0, "reject test");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[2].publicKey);
    await vote(holders[0], id, pPda, false); // big against
    await vote(holders[2], id, pPda, true); // small for
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectErr("execute with against>for → ProposalRejected", "ProposalRejected", () =>
      execute(id, { recipient: ata(holders[0].publicKey) })
    );
  }

  // ===== CHANGE_PARAM + bounds =====
  await expectErr("CHANGE_PARAM quorum=0 → ParamOutOfBounds", "ParamOutOfBounds", async () => {
    const { id, pPda } = await propose(4, me, 0, 2, "zero quorum");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  });
  await expectOk("CHANGE_PARAM finance_daily_bps 50→80", async () => {
    const { id, pPda } = await propose(4, me, 80, 5, "raise finance daily");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  });

  // ===== roles: appoint B finance, C culture; RoleConflict =====
  async function passRole(type: number, target: PublicKey, reason: string) {
    const { id, pPda } = await propose(type, target, 0, 0, reason);
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  }
  await expectOk("appoint holder B as finance minister", () => passRole(2, holders[1].publicKey, "B finance"));
  await expectOk("appoint holder C as culture minister", () => passRole(3, holders[2].publicKey, "C culture"));
  await expectErr("appoint president = finance minister → RoleConflict", "RoleConflict", () =>
    passRole(1, holders[1].publicKey, "conflict")
  );

  // ===== minister spend + daily limit =====
  {
    const t = (await bal(treasury)) as bigint;
    const within = (t * 40n) / 10_000n; // < 0.8% (new finance daily)
    await expectOk("minister_spend within daily limit (finance / B)", () =>
      progFor(holders[1])
        .methods.ministerSpend(1, new anchor.BN(within.toString()), "ads")
        .accounts({
          minister: holders[1].publicKey,
          governanceMint: mint.publicKey,
          config: configPda,
          spendTracker: trackerPda(1),
          treasury,
          recipientTokenAccount: ata(holders[1].publicKey),
          tokenProgram: TP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await expectErr("minister_spend over daily limit → ExceedsDailyLimit", "ExceedsDailyLimit", () =>
      progFor(holders[1])
        .methods.ministerSpend(1, new anchor.BN(((t * 200n) / 10_000n).toString()), "too much")
        .accounts({
          minister: holders[1].publicKey,
          governanceMint: mint.publicKey,
          config: configPda,
          spendTracker: trackerPda(1),
          treasury,
          recipientTokenAccount: ata(holders[1].publicKey),
          tokenProgram: TP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  // ===== salary =====
  {
    const [payroll] = PublicKey.findProgramAddressSync(
      [Buffer.from("payroll"), configPda.toBuffer(), me.toBuffer()],
      PROGRAM_ID
    );
    await expectOk("claim_salary (president)", () =>
      program.methods
        .claimSalary()
        .accounts({
          claimant: me,
          governanceMint: mint.publicKey,
          config: configPda,
          payrollClaim: payroll,
          treasury,
          claimantTokenAccount: myAta,
          tokenProgram: TP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await expectErr("claim_salary twice same day → PayrollTooSoon", "PayrollTooSoon", () =>
      program.methods
        .claimSalary()
        .accounts({
          claimant: me,
          governanceMint: mint.publicKey,
          config: configPda,
          payrollClaim: payroll,
          treasury,
          claimantTokenAccount: myAta,
          tokenProgram: TP,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
  }

  // ===== pause =====
  await expectOk("set_pause(true)", () =>
    program.methods.setPause(true).accounts({ admin: me, config: configPda }).rpc()
  );
  await expectErr("claim_salary while paused → Paused", "Paused", () =>
    program.methods
      .claimSalary()
      .accounts({
        claimant: holders[1].publicKey,
        governanceMint: mint.publicKey,
        config: configPda,
        payrollClaim: PublicKey.findProgramAddressSync(
          [Buffer.from("payroll"), configPda.toBuffer(), holders[1].publicKey.toBuffer()],
          PROGRAM_ID
        )[0],
        treasury,
        claimantTokenAccount: ata(holders[1].publicKey),
        tokenProgram: TP,
        systemProgram: SystemProgram.programId,
      })
      .signers([holders[1]])
      .rpc()
  );
  await expectOk("set_pause(false)", () =>
    program.methods.setPause(false).accounts({ admin: me, config: configPda }).rpc()
  );

  // ===== milestone deposit via governance + cap =====
  {
    const t = (await bal(treasury)) as bigint;
    await expectErr("milestone deposit > 10% cap → ExceedsMilestoneDepositCap", "ExceedsMilestoneDepositCap", () =>
      propose(6, me, (t * 20n) / 100n, 0, "too big deposit")
    );
    // wait out any pending spend cooldown from earlier SPEND
    await waitChain((await chainNow()) + COOL + 2);
    const dep = (t * 8n) / 100n;
    const { id, pPda } = await propose(6, me, dep, 0, "fund milestone");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectOk("execute milestone deposit (type 6)", () => execute(id, { milestoneFund: true }));
    record("milestone fund received deposit", (await bal(milestoneFundPda)) > 0n, `${await bal(milestoneFundPda)}`);
  }

  // ===== milestone cycle =====
  {
    const n = (await program.account.config.fetch(configPda)).nextMilestoneNumber;
    const mPda = milestonePda(n);
    await expectOk("create_milestone", () =>
      program.methods
        .createMilestone()
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: mPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    for (const h of [holders[0], holders[1]]) {
      await expectOk(`milestone snapshot ${h.publicKey.toBase58().slice(0, 4)} (verified weight)`, () =>
        program.methods
          .postMilestoneSnapshot(new anchor.BN(n.toString()), h.publicKey)
          .accounts({
            owner: me,
            governanceMint: mint.publicKey,
            config: configPda,
            milestoneRecord: mPda,
            holderTokenAccount: ata(h.publicKey),
            milestoneSnapshot: mSnapPda(mPda, h.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .rpc()
      );
    }
    await expectErr("milestone snapshot for tiny holder → BelowCitizenshipThreshold", "BelowCitizenshipThreshold", () =>
      program.methods
        .postMilestoneSnapshot(new anchor.BN(n.toString()), holders[2].publicKey)
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: mPda,
          holderTokenAccount: ata(holders[2].publicKey),
          milestoneSnapshot: mSnapPda(mPda, holders[2].publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    await expectOk("finalize_milestone", () =>
      program.methods
        .finalizeMilestone(new anchor.BN(n.toString()))
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: mPda,
          previousMilestone: null,
          milestoneFund: milestoneFundPda,
          tokenProgram: TP,
        })
        .rpc()
    );
    const rec = await program.account.milestoneRecord.fetch(mPda);
    const cfgAfter = await program.account.config.fetch(configPda);
    record(
      "finalize reserved the pool",
      cfgAfter.milestoneReserved.toString() !== "0",
      `payoutBps ${rec.payoutBps}, reserved ${cfgAfter.milestoneReserved}`
    );
    for (const h of [holders[0], holders[1]]) {
      const before = await bal(ata(h.publicKey));
      await expectOk(`push claim_milestone → ${h.publicKey.toBase58().slice(0, 4)} (no signature from holder)`, () =>
        program.methods
          .claimMilestone(new anchor.BN(n.toString()), h.publicKey)
          .accounts({
            payer: me,
            governanceMint: mint.publicKey,
            config: configPda,
            milestoneRecord: mPda,
            milestoneSnapshot: mSnapPda(mPda, h.publicKey),
            milestoneFund: milestoneFundPda,
            claimantTokenAccount: ata(h.publicKey),
            tokenProgram: TP,
          })
          .rpc()
      );
      const after = await bal(ata(h.publicKey));
      record(`  ${h.publicKey.toBase58().slice(0, 4)} received payout`, after > before, `${before} → ${after}`);
    }
    await expectErr("claim_milestone twice → AlreadyClaimedMilestone", "AlreadyClaimedMilestone", () =>
      program.methods
        .claimMilestone(new anchor.BN(n.toString()), holders[0].publicKey)
        .accounts({
          payer: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: mPda,
          milestoneSnapshot: mSnapPda(mPda, holders[0].publicKey),
          milestoneFund: milestoneFundPda,
          claimantTokenAccount: ata(holders[0].publicKey),
          tokenProgram: TP,
        })
        .rpc()
    );
  }

  // ===== milestone 2: unclaimed share returns to the fund =====
  {
    const n2 = (await program.account.config.fetch(configPda)).nextMilestoneNumber;
    const m2 = milestonePda(n2);
    const claimAccts = (h: PublicKey) => ({
      payer: me,
      governanceMint: mint.publicKey,
      config: configPda,
      milestoneRecord: m2,
      milestoneSnapshot: mSnapPda(m2, h),
      milestoneFund: milestoneFundPda,
      claimantTokenAccount: ata(h),
      tokenProgram: TP,
    });
    await expectOk("milestone 2: create", () =>
      program.methods
        .createMilestone()
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: m2,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );
    for (const h of [holders[0], holders[1]]) {
      await program.methods
        .postMilestoneSnapshot(new anchor.BN(n2.toString()), h.publicKey)
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: m2,
          holderTokenAccount: ata(h.publicKey),
          milestoneSnapshot: mSnapPda(m2, h.publicKey),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
    await expectOk("milestone 2: finalize (base excludes milestone 1 reserve)", () =>
      program.methods
        .finalizeMilestone(new anchor.BN(n2.toString()))
        .accounts({
          owner: me,
          governanceMint: mint.publicKey,
          config: configPda,
          milestoneRecord: m2,
          previousMilestone: milestonePda(new anchor.BN(n2.toString()).subn(1)),
          milestoneFund: milestoneFundPda,
          tokenProgram: TP,
        })
        .rpc()
    );
    await expectOk("milestone 2: pay holder A only", () =>
      program.methods
        .claimMilestone(new anchor.BN(n2.toString()), holders[0].publicKey)
        .accounts(claimAccts(holders[0].publicKey))
        .rpc()
    );
    const relAccts = { owner: me, governanceMint: mint.publicKey, config: configPda, milestoneRecord: m2 };
    await expectErr("release before grace period → MilestoneGraceNotElapsed", "MilestoneGraceNotElapsed", () =>
      program.methods.releaseMilestoneReserve(new anchor.BN(n2.toString())).accounts(relAccts).rpc()
    );
    const reservedBefore = (await program.account.config.fetch(configPda)).milestoneReserved;
    await waitChain((await chainNow()) + GRACE + 2);
    await expectOk("release after grace: unclaimed share returns to the fund", () =>
      program.methods.releaseMilestoneReserve(new anchor.BN(n2.toString())).accounts(relAccts).rpc()
    );
    const reservedAfter = (await program.account.config.fetch(configPda)).milestoneReserved;
    record("reserve shrank by B's unclaimed share", reservedAfter.lt(reservedBefore), `${reservedBefore} → ${reservedAfter}`);
    await expectErr("claim on closed milestone → MilestoneClosed", "MilestoneClosed", () =>
      program.methods
        .claimMilestone(new anchor.BN(n2.toString()), holders[1].publicKey)
        .accounts(claimAccts(holders[1].publicKey))
        .rpc()
    );
  }

  // ===== president fallback execution =====
  {
    await expectOk("make holder A president (executed by owners)", () =>
      passRole(1, holders[0].publicKey, "A president")
    );
    // wait out spend cooldown irrelevant (role change) — now propose handing it back to `me`
    const { id, pPda } = await propose(1, me, 0, 0, "president back to owners key");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    const dl = await deadlineOf(pPda);
    await waitChain(dl + TL + 1);
    const execAsA = () =>
      progFor(holders[0])
        .methods.executeProposal(new anchor.BN(id.toString()))
        .accounts({
          executor: holders[0].publicKey,
          governanceMint: mint.publicKey,
          config: configPda,
          proposal: pPda,
          treasury,
          recipientTokenAccount: null,
          milestoneFund: null,
          tokenProgram: TP,
        })
        .rpc();
    await expectErr("president executes too early (owners still have time) → NotOwner", "NotOwner", execAsA);
    await waitChain(dl + TL + FB + 2);
    await expectOk("president executes after owners stay silent (fallback)", execAsA);
    const cfgP = await program.account.config.fetch(configPda);
    record("fallback execution applied the vote", cfgP.president.equals(me), cfgP.president.toBase58());
  }

  // ===== harvest_fees =====
  {
    const before = await bal(treasury);
    await expectOk("harvest_fees (sweep tax into treasury)", () =>
      program.methods
        .harvestFees()
        .accounts({ governanceMint: mint.publicKey, config: configPda, treasury, tokenProgram: TP })
        .remainingAccounts(
          [myAta, ata(holders[0].publicKey), ata(holders[1].publicKey), ata(holders[2].publicKey)].map((pubkey) => ({
            pubkey,
            isWritable: true,
            isSigner: false,
          }))
        )
        .rpc()
    );
    const after = await bal(treasury);
    record("harvest increased treasury", after >= before, `${before} → ${after}`);
  }

  // ---------- summary ----------
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n================  ${pass}/${results.length} PASS  ================`);
  for (const r of results.filter((r) => !r.ok)) console.log(`  FAIL: ${r.name} — ${r.note}`);
  console.log("\nmint:", mint.publicKey.toBase58());
  console.log("config:", configPda.toBase58());
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
