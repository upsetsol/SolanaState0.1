// Full end-to-end scenario suite against a live cluster (local, devnet, testnet).
// Self-contained: creates the governance mint (Token-2022, metadata, NO tax), initialises
// with ultra-short windows (the treasury asset is wSOL), funds 3 holders, then runs every
// governance / money / milestone / negative path, and finally the Meteora pool-fee cycle
// (create pool, register, trade, claim by a stranger). Prints a PASS/FAIL table.
//
//   ANCHOR_PROVIDER_URL=... ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-node scripts/e2e.ts
//
//   SEED_SOL=0.5    starting treasury (wSOL) — the SPEND sizes scale with it
//   POOL_SOL=0.2    SOL put into the Meteora pool
//
// The pool part needs the Meteora DAMM v2 program on the cluster (devnet has it; on a local
// validator start it with --clone-upgradeable-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG
// --url devnet); otherwise it is reported as skipped. Total run ~5-8 min (waits).

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ExtensionType,
  TYPE_SIZE,
  LENGTH_SIZE,
  AuthorityType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  createSyncNativeInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadataIx, pack } from "@solana/spl-token-metadata";
import BN from "bn.js";
import {
  CpAmm, getBaseFeeParams, BaseFeeMode, CollectFeeMode, ActivationType, MIN_SQRT_PRICE, MAX_SQRT_PRICE,
  deriveCustomizablePoolAddress, derivePositionAddress, derivePositionNftAccount,
} from "@meteora-ag/cp-amm-sdk";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as os from "os";

const RPC = process.env.ANCHOR_PROVIDER_URL || "https://api.devnet.solana.com";
const WALLET = (process.env.ANCHOR_WALLET || "~/.config/solana/id.json").replace("~", os.homedir());
const IDL = JSON.parse(
  fs.readFileSync(
    fs.existsSync("./target/idl/onchain_state_solana.json")
      ? "./target/idl/onchain_state_solana.json"
      : "./idl/onchain_state_solana.json",
    "utf8"
  )
);
const PROGRAM_ID = new PublicKey(IDL.address);
const TP = TOKEN_2022_PROGRAM_ID; // governance coin
const TPT = TOKEN_PROGRAM_ID; // treasury asset (wSOL)
const ATAP = ASSOCIATED_TOKEN_PROGRAM_ID;
const DEC = 9;
const METEORA = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
const POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
const SEED_LAMPORTS = BigInt(Math.round(Number(process.env.SEED_SOL ?? "0.5") * 1e9));
const POOL_LAMPORTS = BigInt(Math.round(Number(process.env.POOL_SOL ?? "0.2") * 1e9));

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

// Real networks (devnet/testnet/mainnet) drop transactions and their websockets are flaky, so every send
// here polls getSignatureStatuses over plain HTTP and re-sends with a fresh blockhash when one expires.
const EXPIRED = /expired|block height exceeded|Blockhash not found|blockhash not found/i;
async function confirmPoll(c: Connection, sig: string, lastValidBlockHeight: number) {
  for (;;) {
    const st = (await c.getSignatureStatuses([sig])).value[0];
    if (st) {
      if (st.err) throw new Error("Transaction " + sig + " failed: " + JSON.stringify(st.err));
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    if ((await c.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("block height exceeded");
    await sleep(700);
  }
}
async function sendTx(c: Connection, tx: Transaction, sign: (t: Transaction) => Promise<Transaction>, opts?: any): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const signed = await sign(tx);
      const sig = await c.sendRawTransaction(signed.serialize(), { skipPreflight: opts?.skipPreflight ?? false, preflightCommitment: "confirmed" });
      await confirmPoll(c, sig, lastValidBlockHeight);
      return sig;
    } catch (e: any) {
      if (i < 6 && EXPIRED.test(String(e?.message ?? e))) {
        await sleep(1500);
        continue;
      }
      throw e;
    }
  }
}
(anchor.AnchorProvider.prototype as any).sendAndConfirm = async function (this: any, tx: any, signers?: Keypair[], opts?: any) {
  if (!(tx instanceof Transaction)) throw new Error("only legacy transactions are used in this suite");
  tx.feePayer = tx.feePayer ?? this.wallet.publicKey;
  return sendTx(this.connection, tx, async (t) => {
    t.signatures = []; // fresh blockhash => sign again
    (signers ?? []).forEach((k) => t.partialSign(k));
    return this.wallet.signTransaction(t);
  }, opts ?? this.opts);
};
async function sendRetry(c: Connection, tx: Transaction, signers: Keypair[], _opts: any) {
  tx.feePayer = tx.feePayer ?? signers[0].publicKey;
  return sendTx(c, tx, async (t) => {
    t.signatures = [];
    t.sign(...signers);
    return t;
  });
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
// The program's own clock: the Clock sysvar (unix_timestamp at offset 32). getBlockTime is often null for the
// newest slots on real clusters and the local clock drifts, so neither is safe for boundary-exact waits.
async function chainNow() {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed");
  return Number(info!.data.readBigInt64LE(32));
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

  // ---------- governance mint: Token-2022 + metadata, NO transfer tax ----------
  const mint = Keypair.generate();
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config"), mint.publicKey.toBuffer()], PROGRAM_ID);
  const meta = { mint: mint.publicKey, name: "Test 1", symbol: "TEST1", uri: "", additionalMetadata: [] as [string, string][] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const mintRent = await conn.getMinimumBalanceForRentExemption(mintLen + TYPE_SIZE + LENGTH_SIZE + pack(meta).length);
  const myAta = getAssociatedTokenAddressSync(mint.publicKey, me, false, TP, ATAP);
  const SUPPLY = 1_000_000_000n * 10n ** BigInt(DEC);
  await sendRetry(
    conn,
    new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: me, newAccountPubkey: mint.publicKey, space: mintLen, lamports: mintRent, programId: TP }),
      createInitializeMetadataPointerInstruction(mint.publicKey, me, mint.publicKey, TP),
      createInitializeMintInstruction(mint.publicKey, DEC, me, null, TP),
      createInitMetadataIx({ programId: TP, metadata: mint.publicKey, updateAuthority: me, mint: mint.publicKey, mintAuthority: me, name: meta.name, symbol: meta.symbol, uri: meta.uri }),
      createAssociatedTokenAccountIdempotentInstruction(me, myAta, me, mint.publicKey, TP, ATAP),
      createMintToInstruction(mint.publicKey, myAta, me, SUPPLY, [], TP)
    ),
    [payer, mint],
    { commitment: "confirmed" }
  );
  record("create governance mint (Token-2022, metadata, no tax)", true, mint.publicKey.toBase58());

  // treasury asset = wSOL (classic Token program)
  const treasury = getAssociatedTokenAddressSync(NATIVE_MINT, configPda, true, TPT, ATAP);
  const tAta = (o: PublicKey) => getAssociatedTokenAddressSync(NATIVE_MINT, o, true, TPT, ATAP);
  const ensureT = async (owner: PublicKey) =>
    sendRetry(conn, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(me, tAta(owner), owner, NATIVE_MINT, TPT, ATAP)), [payer], { commitment: "confirmed" });
  const [milestoneFundPda] = PublicKey.findProgramAddressSync([Buffer.from("milestone_fund"), configPda.toBuffer()], PROGRAM_ID);
  const feeAAccount = getAssociatedTokenAddressSync(mint.publicKey, configPda, true, TP, ATAP);
  const ata = (o: PublicKey) => getAssociatedTokenAddressSync(mint.publicKey, o, false, TP, ATAP);
  const proposalPda = (id: any) => PublicKey.findProgramAddressSync([Buffer.from("proposal"), configPda.toBuffer(), u64(id)], PROGRAM_ID)[0];
  const snapPda = (p: PublicKey, v: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("voter_snapshot"), p.toBuffer(), v.toBuffer()], PROGRAM_ID)[0];
  const trackerPda = (role: number) => PublicKey.findProgramAddressSync([Buffer.from("spend_tracker"), configPda.toBuffer(), Buffer.from([role])], PROGRAM_ID)[0];
  const milestonePda = (n: any) => PublicKey.findProgramAddressSync([Buffer.from("milestone"), configPda.toBuffer(), u64(n)], PROGRAM_ID)[0];
  const mSnapPda = (m: PublicKey, h: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("milestone_snap"), m.toBuffer(), h.toBuffer()], PROGRAM_ID)[0];
  const payrollPda = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("payroll"), configPda.toBuffer(), o.toBuffer()], PROGRAM_ID)[0];
  const bal = async (a: PublicKey) => {
    try {
      return (await getAccount(conn, a, "confirmed", TP)).amount;
    } catch {
      return -1n;
    }
  };
  const tbal = async (a: PublicKey) => {
    try {
      return (await getAccount(conn, a, "confirmed", TPT)).amount;
    } catch {
      return -1n;
    }
  };
  // the pool vault excluded from the voting base (null until register_pool)
  const excl = async (): Promise<PublicKey | null> => {
    const k: PublicKey = (await program.account.config.fetch(configPda)).quorumExcludedAccount;
    return k.equals(PublicKey.default) ? null : k;
  };

  // ---------- initialize (ultra-short windows) ----------
  // Ultra-short windows suit a local validator (instant transactions). On a real network set E2E_SLOW=1:
  // a proposal needs ~5 transactions between creation and the last vote, so the window must outlast them.
  const SLOW = process.env.E2E_SLOW === "1";
  const VOTE = SLOW ? 75 : 14,
    TL = SLOW ? 15 : 8,
    COOL = SLOW ? 20 : 10,
    FB = SLOW ? 12 : 6,
    GRACE = SLOW ? 20 : 8;
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
        treasuryMint: NATIVE_MINT,
        config: configPda,
        treasury,
        tokenProgram: TPT,
        associatedTokenProgram: ATAP,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  await expectOk("setup_milestone_fund", () =>
    program.methods
      .setupMilestoneFund()
      .accounts({ owner: me, config: configPda, treasuryMint: NATIVE_MINT, milestoneFund: milestoneFundPda, tokenProgram: TPT, systemProgram: SystemProgram.programId })
      .rpc()
  );

  // ---------- holders ----------
  const holders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const labels = ["A", "B", "C"];
  // fund SOL + create ATAs + distribute tokens (A big, B mid, C small)
  const amts = [200_000_000n, 60_000_000n, 2_000_000n].map((x) => x * 10n ** BigInt(DEC)); // 20% / 6% / 0.2%
  {
    const tx = new Transaction();
    for (const h of holders) tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: h.publicKey, lamports: 0.02 * LAMPORTS_PER_SOL }));
    await sendRetry(conn, tx, [payer], { commitment: "confirmed" });
  }
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i];
    const hAta = ata(h.publicKey);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(me, hAta, h.publicKey, mint.publicKey, TP, ATAP),
      createTransferCheckedInstruction(myAta, mint.publicKey, hAta, me, amts[i], DEC, [], TP)
    );
    await sendRetry(conn, tx, [payer], { commitment: "confirmed" });
    console.log(`  holder ${labels[i]} ${h.publicKey.toBase58()} balance ${await bal(hAta)}`);
  }
  {
    const a = await bal(ata(holders[0].publicKey));
    record("distribute coins to 3 holders (no transfer tax: exact amounts arrive)", a === amts[0], `${a}`);
  }
  // treasury-asset accounts for everybody who will be paid
  for (const o of [me, ...holders.map((h) => h.publicKey)]) await ensureT(o);

  const progFor = (kp: Keypair) =>
    new anchor.Program(IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(kp), { commitment: "confirmed" })) as any;

  // helper: create + snapshot voters + vote
  const createAccts = async (creator: PublicKey, creatorAta: PublicKey, pPda: PublicKey) => ({
    creator,
    config: configPda,
    governanceMint: mint.publicKey,
    creatorTokenAccount: creatorAta,
    treasury,
    quorumExcluded: await excl(),
    proposal: pPda,
    systemProgram: SystemProgram.programId,
  });
  async function propose(type: number, target: PublicKey, amount: any, paramKey: number, reason: string) {
    const cfg = await program.account.config.fetch(configPda);
    const id = cfg.proposalCount;
    const pPda = proposalPda(id);
    await program.methods
      .createProposal(type, target, new anchor.BN(amount.toString()), paramKey, reason)
      .accounts(await createAccts(me, myAta, pPda))
      .rpc();
    return { id, pPda };
  }
  const snapAccts = (pPda: PublicKey, voter: PublicKey, owner: PublicKey = me) => ({
    owner,
    config: configPda,
    proposal: pPda,
    voterTokenAccount: ata(voter),
    voterSnapshot: snapPda(pPda, voter),
    systemProgram: SystemProgram.programId,
  });
  async function snapshot(id: any, pPda: PublicKey, voter: PublicKey, prog: any = program) {
    await prog.methods
      .postVoterSnapshot(new anchor.BN(id.toString()), voter)
      .accounts(snapAccts(pPda, voter, prog.provider.wallet.publicKey))
      .rpc();
  }
  async function vote(kp: Keypair, id: any, pPda: PublicKey, support: boolean) {
    await progFor(kp)
      .methods.vote(new anchor.BN(id.toString()), support)
      .accounts({ voter: kp.publicKey, config: configPda, proposal: pPda, voterSnapshot: snapPda(pPda, kp.publicKey) })
      .rpc();
  }
  async function execute(id: any, opts: { recipient?: PublicKey; milestoneFund?: boolean } = {}, who: Keypair = payer) {
    await progFor(who)
      .methods.executeProposal(new anchor.BN(id.toString()))
      .accounts({
        executor: who.publicKey,
        config: configPda,
        governanceMint: mint.publicKey,
        treasuryMint: NATIVE_MINT,
        proposal: proposalPda(id),
        treasury,
        recipientTokenAccount: opts.recipient ?? null,
        milestoneFund: opts.milestoneFund ? milestoneFundPda : null,
        quorumExcluded: await excl(),
        tokenProgram: TPT,
      })
      .rpc();
  }
  async function deadlineOf(pPda: PublicKey) {
    return Number((await program.account.proposal.fetch(pPda)).deadline.toString());
  }
  async function passWithAB(type: number, target: PublicKey, amount: any, paramKey: number, reason: string) {
    const { id, pPda } = await propose(type, target, amount, paramKey, reason);
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[1].publicKey);
    await vote(holders[0], id, pPda, true);
    await vote(holders[1], id, pPda, true);
    return { id, pPda };
  }

  // ===== SPEND happy path + cooldown =====
  {
    // The treasury is fed by the pool fee; for the scenario suite seed it with wrapped SOL.
    await sendRetry(
      conn,
      new Transaction().add(
        SystemProgram.transfer({ fromPubkey: me, toPubkey: treasury, lamports: Number(SEED_LAMPORTS) }),
        createSyncNativeInstruction(treasury, TPT)
      ),
      [payer],
      { commitment: "confirmed" }
    );
    const tBefore = await tbal(treasury);
    record("treasury seeded with wSOL", tBefore === SEED_LAMPORTS, `${tBefore}`);

    // Two SPEND proposals created + voted up front, so the second is ready to
    // execute the instant the first one does (to actually hit the cooldown).
    const p1 = await propose(0, holders[0].publicKey, SEED_LAMPORTS / 10n, 0, "spend #1");
    await snapshot(p1.id, p1.pPda, holders[0].publicKey);
    await expectErr("snapshot posted by a non-owner → NotOwner", "NotOwner", () =>
      snapshot(p1.id, p1.pPda, holders[1].publicKey, progFor(holders[1]))
    );
    await snapshot(p1.id, p1.pPda, holders[1].publicKey);
    await vote(holders[0], p1.id, p1.pPda, true);
    await expectErr("vote twice → AlreadyVoted", "AlreadyVoted", () => vote(holders[0], p1.id, p1.pPda, true));
    await vote(holders[1], p1.id, p1.pPda, true);
    await expectErr("snapshot after voting started → VotingAlreadyStarted", "VotingAlreadyStarted", () =>
      snapshot(p1.id, p1.pPda, holders[2].publicKey)
    );

    const p2 = await propose(0, holders[0].publicKey, SEED_LAMPORTS / 100n, 0, "spend #2");
    await snapshot(p2.id, p2.pPda, holders[0].publicKey);
    await snapshot(p2.id, p2.pPda, holders[1].publicKey);
    await vote(holders[0], p2.id, p2.pPda, true);
    await vote(holders[1], p2.id, p2.pPda, true);

    // just after the deadline, before deadline + timelock
    const dl1 = Math.max(await deadlineOf(p1.pPda), await deadlineOf(p2.pPda));
    await waitChain(dl1 + 1);
    await expectErr("execute right after the deadline → TimelockNotElapsed", "TimelockNotElapsed", () =>
      execute(p1.id, { recipient: tAta(holders[0].publicKey) })
    );
    await waitChain(dl1 + TL + 2);

    await expectErr("execute by non-owner → NotOwner", "NotOwner", () =>
      execute(p1.id, { recipient: tAta(holders[0].publicKey) }, holders[0])
    );
    await expectOk("execute SPEND #1 (owner)", () => execute(p1.id, { recipient: tAta(holders[0].publicKey) }));
    const tAfter = await tbal(treasury);
    record("SPEND moved treasury wSOL to the recipient", tAfter < tBefore, `${tBefore} → ${tAfter}`);
    await expectErr("execute the same proposal again → AlreadyExecuted", "AlreadyExecuted", () =>
      execute(p1.id, { recipient: tAta(holders[0].publicKey) })
    );

    await expectErr("2nd SPEND inside cooldown → SpendCooldown", "SpendCooldown", () =>
      execute(p2.id, { recipient: tAta(holders[0].publicKey) })
    );
    await waitChain((await chainNow()) + COOL + 2);
    await expectErr("SPEND paid to somebody else's account → WrongRecipient", "WrongRecipient", () =>
      execute(p2.id, { recipient: tAta(holders[1].publicKey) })
    );
    await expectOk("SPEND #2 after cooldown elapsed", () => execute(p2.id, { recipient: tAta(holders[0].publicKey) }));
  }

  // ===== negative: below threshold / spend cap =====
  {
    const nextId = (await program.account.config.fetch(configPda)).proposalCount;
    await expectErr("create SPEND from tiny holder → BelowThreshold", "BelowThreshold", async () =>
      progFor(holders[2])
        .methods.createProposal(0, holders[2].publicKey, new anchor.BN("1000"), 0, "nope")
        .accounts(await createAccts(holders[2].publicKey, ata(holders[2].publicKey), proposalPda(nextId)))
        .rpc()
    );
  }
  {
    const t = await tbal(treasury);
    await expectErr("create SPEND > 30% cap → ExceedsSpendCap", "ExceedsSpendCap", () =>
      propose(0, holders[0].publicKey, ((t as bigint) * 4n) / 10n, 0, "too big")
    );
  }

  // ===== quorum not reached =====
  {
    const { id, pPda } = await propose(0, holders[0].publicKey, 1000n, 0, "quorum test");
    await snapshot(id, pPda, holders[2].publicKey); // only tiny holder
    await vote(holders[2], id, pPda, true);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectErr("execute below quorum → QuorumNotReached", "QuorumNotReached", () =>
      execute(id, { recipient: tAta(holders[0].publicKey) })
    );
  }

  // ===== majority rejected =====
  {
    const { id, pPda } = await propose(0, holders[0].publicKey, 1000n, 0, "reject test");
    await snapshot(id, pPda, holders[0].publicKey);
    await snapshot(id, pPda, holders[2].publicKey);
    await vote(holders[0], id, pPda, false); // big against
    await vote(holders[2], id, pPda, true); // small for
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectErr("execute with against>for → ProposalRejected", "ProposalRejected", () =>
      execute(id, { recipient: tAta(holders[0].publicKey) })
    );
  }

  // ===== CHANGE_PARAM + bounds =====
  await expectErr("CHANGE_PARAM quorum=0 → ParamOutOfBounds", "ParamOutOfBounds", async () => {
    const { id, pPda } = await passWithAB(4, me, 0, 2, "zero quorum");
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  });
  await expectOk("CHANGE_PARAM finance_daily_bps 50→80", async () => {
    const { id, pPda } = await passWithAB(4, me, 80, 5, "raise finance daily");
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  });

  // ===== roles: appoint B finance, C culture; RoleConflict =====
  async function passRole(type: number, target: PublicKey, reason: string) {
    const { id, pPda } = await passWithAB(type, target, 0, 0, reason);
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await execute(id);
  }
  await expectOk("appoint holder B as finance minister", () => passRole(2, holders[1].publicKey, "B finance"));
  await expectOk("appoint holder C as culture minister", () => passRole(3, holders[2].publicKey, "C culture"));
  await expectErr("appoint president = finance minister → RoleConflict", "RoleConflict", () =>
    passRole(1, holders[1].publicKey, "conflict")
  );

  // ===== minister spend + daily limit =====
  const spendAccts = (kp: Keypair) => ({
    minister: kp.publicKey,
    config: configPda,
    treasuryMint: NATIVE_MINT,
    spendTracker: trackerPda(1),
    treasury,
    recipientTokenAccount: tAta(kp.publicKey),
    tokenProgram: TPT,
    systemProgram: SystemProgram.programId,
  });
  {
    const t = (await tbal(treasury)) as bigint;
    const within = (t * 40n) / 10_000n; // < 0.8% (new finance daily)
    await expectOk("minister_spend within daily limit (finance / B)", () =>
      progFor(holders[1]).methods.ministerSpend(1, new anchor.BN(within.toString()), "ads").accounts(spendAccts(holders[1])).rpc()
    );
    await expectErr("minister_spend over daily limit → ExceedsDailyLimit", "ExceedsDailyLimit", () =>
      progFor(holders[1])
        .methods.ministerSpend(1, new anchor.BN(((t * 200n) / 10_000n).toString()), "too much")
        .accounts(spendAccts(holders[1]))
        .rpc()
    );
  }

  // ===== salary =====
  const salaryAccts = (kp: Keypair) => ({
    claimant: kp.publicKey,
    config: configPda,
    treasuryMint: NATIVE_MINT,
    payrollClaim: payrollPda(kp.publicKey),
    treasury,
    claimantTokenAccount: tAta(kp.publicKey),
    tokenProgram: TPT,
    systemProgram: SystemProgram.programId,
  });
  {
    const before = await tbal(tAta(me));
    await expectOk("claim_salary (president)", () => program.methods.claimSalary().accounts(salaryAccts(payer)).rpc());
    record("salary arrived in wSOL", (await tbal(tAta(me))) > before, `${before} → ${await tbal(tAta(me))}`);
    await expectErr("claim_salary twice same day → PayrollTooSoon", "PayrollTooSoon", () =>
      program.methods.claimSalary().accounts(salaryAccts(payer)).rpc()
    );
  }

  // ===== pause =====
  await expectOk("set_pause(true)", () => program.methods.setPause(true).accounts({ admin: me, config: configPda }).rpc());
  await expectErr("claim_salary while paused → Paused", "Paused", () =>
    progFor(holders[1]).methods.claimSalary().accounts(salaryAccts(holders[1])).rpc()
  );
  await expectOk("set_pause(false)", () => program.methods.setPause(false).accounts({ admin: me, config: configPda }).rpc());

  // ===== milestone deposit via governance + cap =====
  {
    const t = (await tbal(treasury)) as bigint;
    await expectErr("milestone deposit > 10% cap → ExceedsMilestoneDepositCap", "ExceedsMilestoneDepositCap", () =>
      propose(6, me, (t * 20n) / 100n, 0, "too big deposit")
    );
    // wait out any pending spend cooldown from earlier SPEND
    await waitChain((await chainNow()) + COOL + 2);
    const dep = (t * 8n) / 100n;
    const { id, pPda } = await passWithAB(6, me, dep, 0, "fund milestone");
    await waitChain((await deadlineOf(pPda)) + TL + 2);
    await expectOk("execute milestone deposit (type 6)", () => execute(id, { milestoneFund: true }));
    record("milestone fund received deposit (wSOL)", (await tbal(milestoneFundPda)) > 0n, `${await tbal(milestoneFundPda)}`);
  }

  // ===== milestone cycle =====
  const msAccts = (m: PublicKey, n: any) => ({ owner: me, config: configPda, governanceMint: mint.publicKey, milestoneRecord: m, systemProgram: SystemProgram.programId });
  const msSnap = (m: PublicKey, n: any, h: PublicKey) =>
    program.methods
      .postMilestoneSnapshot(new anchor.BN(n.toString()), h)
      .accounts({ ...msAccts(m, n), holderTokenAccount: ata(h), milestoneSnapshot: mSnapPda(m, h) })
      .rpc();
  const claimAccts = (m: PublicKey, h: PublicKey) => ({
    payer: me,
    config: configPda,
    treasuryMint: NATIVE_MINT,
    milestoneRecord: m,
    milestoneSnapshot: mSnapPda(m, h),
    milestoneFund: milestoneFundPda,
    claimantTokenAccount: tAta(h),
    tokenProgram: TPT,
  });
  {
    const n = (await program.account.config.fetch(configPda)).nextMilestoneNumber;
    const mPda = milestonePda(n);
    await expectOk("create_milestone", () =>
      program.methods.createMilestone().accounts({ owner: me, config: configPda, milestoneRecord: mPda, systemProgram: SystemProgram.programId }).rpc()
    );
    for (const h of [holders[0], holders[1]]) {
      await expectOk(`milestone snapshot ${h.publicKey.toBase58().slice(0, 4)} (verified weight)`, () => msSnap(mPda, n, h.publicKey));
    }
    await expectErr("milestone snapshot for tiny holder → BelowCitizenshipThreshold", "BelowCitizenshipThreshold", () =>
      msSnap(mPda, n, holders[2].publicKey)
    );
    await expectOk("finalize_milestone", () =>
      program.methods
        .finalizeMilestone(new anchor.BN(n.toString()))
        .accounts({ owner: me, config: configPda, milestoneRecord: mPda, previousMilestone: null, milestoneFund: milestoneFundPda })
        .rpc()
    );
    const rec = await program.account.milestoneRecord.fetch(mPda);
    const cfgAfter = await program.account.config.fetch(configPda);
    record("finalize reserved the pool", cfgAfter.milestoneReserved.toString() !== "0", `payoutBps ${rec.payoutBps}, reserved ${cfgAfter.milestoneReserved}`);
    for (const h of [holders[0], holders[1]]) {
      const before = await tbal(tAta(h.publicKey));
      await expectOk(`push claim_milestone → ${h.publicKey.toBase58().slice(0, 4)} (no signature from holder)`, () =>
        program.methods.claimMilestone(new anchor.BN(n.toString()), h.publicKey).accounts(claimAccts(mPda, h.publicKey)).rpc()
      );
      const after = await tbal(tAta(h.publicKey));
      record(`  ${h.publicKey.toBase58().slice(0, 4)} received payout (wSOL)`, after > before, `${before} → ${after}`);
    }
    await expectErr("claim_milestone twice → AlreadyClaimedMilestone", "AlreadyClaimedMilestone", () =>
      program.methods.claimMilestone(new anchor.BN(n.toString()), holders[0].publicKey).accounts(claimAccts(mPda, holders[0].publicKey)).rpc()
    );
  }

  // ===== milestone 2: unclaimed share returns to the fund =====
  {
    const n2 = (await program.account.config.fetch(configPda)).nextMilestoneNumber;
    const m2 = milestonePda(n2);
    await expectOk("milestone 2: create", () =>
      program.methods.createMilestone().accounts({ owner: me, config: configPda, milestoneRecord: m2, systemProgram: SystemProgram.programId }).rpc()
    );
    for (const h of [holders[0], holders[1]]) await msSnap(m2, n2, h.publicKey);
    await expectOk("milestone 2: finalize (base excludes milestone 1 reserve)", () =>
      program.methods
        .finalizeMilestone(new anchor.BN(n2.toString()))
        .accounts({ owner: me, config: configPda, milestoneRecord: m2, previousMilestone: milestonePda(new anchor.BN(n2.toString()).subn(1)), milestoneFund: milestoneFundPda })
        .rpc()
    );
    await expectOk("milestone 2: pay holder A only", () =>
      program.methods.claimMilestone(new anchor.BN(n2.toString()), holders[0].publicKey).accounts(claimAccts(m2, holders[0].publicKey)).rpc()
    );
    const relAccts = { owner: me, config: configPda, milestoneRecord: m2 };
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
      program.methods.claimMilestone(new anchor.BN(n2.toString()), holders[1].publicKey).accounts(claimAccts(m2, holders[1].publicKey)).rpc()
    );
  }

  // ===== president fallback execution =====
  {
    await expectOk("make holder A president (executed by owners)", () => passRole(1, holders[0].publicKey, "A president"));
    // now propose handing it back to `me`
    const { id, pPda } = await passWithAB(1, me, 0, 0, "president back to owners key");
    const dl = await deadlineOf(pPda);
    await waitChain(dl + TL + 1);
    const execAsA = () => execute(id, {}, holders[0]);
    await expectErr("president executes too early (owners still have time) → NotOwner", "NotOwner", execAsA);
    await waitChain(dl + TL + FB + 2);
    await expectOk("president executes after owners stay silent (fallback)", execAsA);
    const cfgP = await program.account.config.fetch(configPda);
    record("fallback execution applied the vote", cfgP.president.equals(me), cfgP.president.toBase58());
  }

  // ===== Meteora pool fee -> treasury =====
  const claimAcctsFor = async (caller: PublicKey, treasuryAcct: PublicKey = treasury) => {
    const cfg = await program.account.config.fetch(configPda);
    const info = await conn.getAccountInfo(cfg.feePool.equals(PublicKey.default) ? SystemProgram.programId : cfg.feePool);
    const vaultA = cfg.feePool.equals(PublicKey.default) || !info ? SystemProgram.programId : new PublicKey(info.data.subarray(232, 264));
    const vaultB = cfg.feePool.equals(PublicKey.default) || !info ? SystemProgram.programId : new PublicKey(info.data.subarray(264, 296));
    return {
      caller,
      config: configPda,
      governanceMint: mint.publicKey,
      treasuryMint: NATIVE_MINT,
      treasury: treasuryAcct,
      feeAAccount,
      poolAuthority: POOL_AUTHORITY,
      pool: cfg.feePool,
      position: cfg.feePosition,
      tokenAVault: vaultA,
      tokenBVault: vaultB,
      positionNftAccount: cfg.feePositionNftAccount,
      tokenAProgram: TP,
      tokenBProgram: TPT,
      eventAuthority: PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], METEORA)[0],
      meteoraProgram: METEORA,
    };
  };
  const registerAccts = (owner: PublicKey, pool: PublicKey, position: PublicKey, nftAccount: PublicKey) => ({
    owner,
    config: configPda,
    governanceMint: mint.publicKey,
    pool,
    position,
    positionNftAccount: nftAccount,
    feeAAccount,
    governanceTokenProgram: TP,
    associatedTokenProgram: ATAP,
    systemProgram: SystemProgram.programId,
  });
  if (!(await conn.getAccountInfo(METEORA))) {
    record("pool fee cycle SKIPPED: Meteora DAMM v2 is not on this cluster", true, "use devnet, or a local validator with the cloned program");
  } else {
    // before register_pool there is neither a linked pool nor the Config-owned "token A" account
    await expectErr("claim_pool_fees before a pool is registered fails → AccountNotInitialized", "AccountNotInitialized", async () =>
      progFor(holders[2]).methods.claimPoolFees().accounts(await claimAcctsFor(holders[2].publicKey)).rpc()
    );

    // create the pool: governance coin (A) / wSOL (B), constant 5% fee only in B, liquidity locked forever
    const cpAmm = new CpAmm(conn);
    const positionNft = Keypair.generate();
    const poolAddr = deriveCustomizablePoolAddress(mint.publicKey, NATIVE_MINT);
    const tokenAAmount = new BN(100_000_000).mul(new BN(10).pow(new BN(DEC)));
    const tokenBAmount = new BN(POOL_LAMPORTS.toString());
    const prep = cpAmm.preparePoolCreationParams({ tokenAAmount, tokenBAmount, minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: CollectFeeMode.OnlyB } as any);
    const poolFees = {
      baseFee: getBaseFeeParams({ baseFeeMode: BaseFeeMode.FeeTimeSchedulerLinear, feeTimeSchedulerParam: { startingFeeBps: 500, endingFeeBps: 500, numberOfPeriod: 0, totalDuration: 0 } }),
      compoundingFeeBps: 0, padding: 0, dynamicFee: null,
    };
    await expectOk("create Meteora pool (5% fee only in SOL, liquidity locked forever)", async () => {
      const { tx } = await cpAmm.createCustomPool({
        payer: me, creator: me, positionNft: positionNft.publicKey, tokenAMint: mint.publicKey, tokenBMint: NATIVE_MINT, tokenAAmount, tokenBAmount,
        sqrtMinPrice: MIN_SQRT_PRICE, sqrtMaxPrice: MAX_SQRT_PRICE, initSqrtPrice: prep.initSqrtPrice, liquidityDelta: prep.liquidityDelta,
        poolFees, hasAlphaVault: false, activationType: ActivationType.Timestamp, collectFeeMode: CollectFeeMode.OnlyB, activationPoint: null,
        tokenAProgram: TP, tokenBProgram: TPT, isLockLiquidity: true,
      } as any);
      await provider.sendAndConfirm(tx, [positionNft]);
    });
    const position = derivePositionAddress(positionNft.publicKey);
    const nftAccount = derivePositionNftAccount(positionNft.publicKey);

    // register while the NFT still belongs to us: the program must refuse
    await expectErr("register_pool while the wallet still holds the position → PositionMismatch", "PositionMismatch", () =>
      program.methods.registerPool().accounts(registerAccts(me, poolAddr, position, nftAccount)).rpc()
    );
    await expectOk("hand the position NFT to the Config PDA", () =>
      provider.sendAndConfirm(new Transaction().add(createSetAuthorityInstruction(nftAccount, me, AuthorityType.AccountOwner, configPda, [], TP)))
    );
    await expectErr("register_pool by a non-owner → NotOwner", "NotOwner", () =>
      progFor(holders[0]).methods.registerPool().accounts(registerAccts(holders[0].publicKey, poolAddr, position, nftAccount)).rpc()
    );
    await expectErr("register_pool with a fake pool account → PoolMismatch", "PoolMismatch", () =>
      program.methods.registerPool().accounts(registerAccts(me, treasury, position, nftAccount)).rpc()
    );
    await expectOk("register_pool (owners_authority)", () => program.methods.registerPool().accounts(registerAccts(me, poolAddr, position, nftAccount)).rpc());
    await expectErr("register_pool a second time → PoolAlreadyRegistered", "PoolAlreadyRegistered", () =>
      program.methods.registerPool().accounts(registerAccts(me, poolAddr, position, nftAccount)).rpc()
    );
    {
      const cfg = await program.account.config.fetch(configPda);
      const poolInfo = await conn.getAccountInfo(poolAddr);
      const vaultA = new PublicKey(poolInfo!.data.subarray(232, 264));
      record("pool vault A is now excluded from the voting base", cfg.quorumExcludedAccount.equals(vaultA), vaultA.toBase58());
    }
    await expectErr("create_proposal without the pool vault → ExcludedAccountMissing", "ExcludedAccountMissing", async () => {
      const nextId = (await program.account.config.fetch(configPda)).proposalCount;
      const a: any = await createAccts(me, myAta, proposalPda(nextId));
      a.quorumExcluded = null;
      await program.methods.createProposal(0, holders[0].publicKey, new anchor.BN(1000), 0, "no vault").accounts(a).rpc();
    });
    await expectOk("create_proposal with the pool vault passed", async () => {
      await propose(0, holders[0].publicKey, 1000n, 0, "with vault");
    });

    // trades: buy then sell, from the deployer wallet
    const swap = async (inMint: PublicKey, outMint: PublicKey, amountIn: BN) => {
      const st: any = await cpAmm.fetchPoolState(poolAddr);
      const tx = await cpAmm.swap({
        payer: me, pool: poolAddr, inputTokenMint: inMint, outputTokenMint: outMint, amountIn, minimumAmountOut: new BN(0),
        tokenAMint: mint.publicKey, tokenBMint: NATIVE_MINT, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
        tokenAProgram: TP, tokenBProgram: TPT, referralTokenAccount: null, poolState: st,
      } as any);
      await provider.sendAndConfirm(tx);
    };
    const buyLamports = 20_000_000n;
    await expectOk("buy coins in the pool (0.02 SOL)", () => swap(NATIVE_MINT, mint.publicKey, new BN(buyLamports.toString())));
    await expectOk("sell coins in the pool (1M coins)", () => swap(mint.publicKey, NATIVE_MINT, new BN(1_000_000).mul(new BN(10).pow(new BN(DEC)))));

    const tBefore = (await tbal(treasury)) as bigint;
    await expectOk("claim_pool_fees called by a stranger (tiny holder C)", async () =>
      progFor(holders[2]).methods.claimPoolFees().accounts(await claimAcctsFor(holders[2].publicKey)).rpc()
    );
    const gained = ((await tbal(treasury)) as bigint) - tBefore;
    // the buy alone produced 5% of 0.02 SOL = 1,000,000 lamports of fee, 80% of it (800,000) belongs to the LP
    record("the pool fee landed in the treasury (wSOL)", gained >= 800_000n && gained < 5n * buyLamports, `+${gained} lamports`);

    // the destination is fixed: an attacker's account instead of the treasury must be rejected
    const attackerAta = tAta(holders[2].publicKey);
    await expectErr("claim_pool_fees with a different destination → ConstraintAddress", "ConstraintAddress", async () =>
      progFor(holders[2]).methods.claimPoolFees().accounts(await claimAcctsFor(holders[2].publicKey, attackerAta)).rpc()
    );
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
