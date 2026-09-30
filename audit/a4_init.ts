// A4 — what `initialize` / `register_pool` do NOT check.  Anyone can call `initialize` for any mint.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a4_init.ts
import { SystemProgram, Transaction } from "@solana/web3.js";
import {
  ExtensionType, createInitializePermanentDelegateInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  group, record, recordKnown, newFunded, createGovMint, configPdaOf, progFor, NATIVE_MINT, TP, TPT, ATAP, initArgs, DEFAULT_PARAMS,
  sendSigned, finish, errText, makeWorld, SOL,
} from "./lib";

async function main() {
  group("A4 initialize / register_pool trust");
  const treasuryOf = (cfgPda: any) => getAssociatedTokenAddressSync(NATIVE_MINT, cfgPda, true, TPT, ATAP);
  const initAccts = (payerKey: any, mint: any) => ({
    owner: payerKey, governanceMint: mint, treasuryMint: NATIVE_MINT, config: configPdaOf(mint), treasury: treasuryOf(configPdaOf(mint)),
    tokenProgram: TPT, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
  });

  // ---- A4.1 / A4.2  squat someone else's mint with hostile, unchecked parameters
  {
    const victim = await newFunded(50);
    const attacker = await newFunded(50);
    const { mint } = await createGovMint(victim); // the victim's brand-new coin (victim is the mint authority)
    const hostile = { ...DEFAULT_PARAMS, vote: 1, timelock: 0, cooldown: 0, thresholdBps: 0, quorumSpendBps: 0, quorumRoleBps: 0, quorumParamBps: 0, payPres: 10_000, payFin: 10_000, payCul: 10_000, finDaily: 10_000, finWeekly: 10_000, culDaily: 10_000, culWeekly: 10_000 };
    let squatted = false, err = "";
    try {
      await progFor(attacker).methods.initialize(...initArgs(attacker.publicKey, attacker.publicKey, attacker.publicKey, hostile)).accounts(initAccts(attacker.publicKey, mint.publicKey)).rpc();
      squatted = true;
    } catch (e) { err = errText(e).slice(0, 200); }
    recordKnown("A4.1", "a stranger initialises a state on the VICTIM's mint before the victim does (he never signed anything, isn't the mint authority)", squatted, "ACCEPTED", squatted ? "attacker is now owners_authority/admin/president of the state tied to the victim's coin (decision 2026-09-30: `initialize` stays open)" : err);
    if (squatted) {
      const cfg: any = await progFor(attacker).account.config.fetch(configPdaOf(mint.publicKey));
      recordKnown("A4.2", "…and `initialize` accepted degenerate parameters without any bounds check", true, "ACCEPTED",
        `voting period ${cfg.votingPeriodSecs}s, timelock ${cfg.timelockSecs}s, quorums ${cfg.quorumSpendBps}/${cfg.quorumRoleBps}/${cfg.quorumParamBps} bps, proposal threshold ${cfg.proposalThresholdBps} bps, president payroll ${cfg.payrollPresidentBps} bps/day (=${Number(cfg.payrollPresidentBps) / 100}% per day), finance limit ${cfg.financeDailyBps} bps/day`);
      let victimOk = false, verr = "";
      try {
        await progFor(victim).methods.initialize(...initArgs(victim.publicKey, victim.publicKey, victim.publicKey, DEFAULT_PARAMS)).accounts(initAccts(victim.publicKey, mint.publicKey)).rpc();
        victimOk = true;
      } catch (e) { verr = errText(e).slice(0, 120); }
      if (victimOk) record("A4.3", "the real owner then tries to initialise his own coin", "OK", "worked");
      else recordKnown("A4.3", "the real owner then tries to initialise his own coin", true, "ACCEPTED", "FAILS (the Config PDA for that mint is taken forever) → the coin can never get a legitimate state; a new mint is needed");
    }
  }

  // ---- A4.4  pre-create the treasury ATA of a future Config PDA → initialize can never succeed
  {
    const victim = await newFunded(50);
    const attacker = await newFunded(50);
    const { mint } = await createGovMint(victim);
    const cfgPda = configPdaOf(mint.publicKey);
    const t = treasuryOf(cfgPda);
    // anyone may create the wSOL associated account of any owner (even of a PDA that does not exist yet) for ~0.002 SOL
    await sendSigned(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(attacker.publicKey, t, cfgPda, NATIVE_MINT, TPT, ATAP)), [attacker]);
    let ok = false, err = "";
    try {
      await progFor(victim).methods.initialize(...initArgs(victim.publicKey, victim.publicKey, victim.publicKey, DEFAULT_PARAMS)).accounts(initAccts(victim.publicKey, mint.publicKey)).rpc();
      ok = true;
    } catch (e) { err = errText(e); }
    recordKnown("A4.4", "griefing: attacker pre-creates the future treasury account (a 0.002 SOL ATA) → the owner's initialize fails", !ok, "ACCEPTED", ok ? "initialize still worked" : "initialize FAILED for the real owner (the associated-token program refuses to re-create the existing account: \"Provided owner is not allowed\")");
  }

  // ---- A4.5  a Token-2022 governance mint with a PERMANENT DELEGATE is accepted
  {
    const dev = await newFunded(50);
    const evil = await newFunded(5);
    const { mint } = await createGovMint(dev, {
      extraExt: [ExtensionType.PermanentDelegate],
      extra: (m) => [createInitializePermanentDelegateInstruction(m, evil.publicKey, TP)],
    });
    let ok = false, err = "";
    try {
      await progFor(dev).methods.initialize(...initArgs(dev.publicKey, dev.publicKey, dev.publicKey, DEFAULT_PARAMS)).accounts(initAccts(dev.publicKey, mint.publicKey)).rpc();
      ok = true;
    } catch (e) { err = errText(e).slice(0, 160); }
    recordKnown("A4.5", "governance mint with a hidden PermanentDelegate (can move/burn ANY holder's coins, incl. the pool vault) is accepted by initialize", ok, "ACCEPTED", ok ? "no check of mint extensions / authorities: users must verify the mint themselves" : err);
  }

  // ---- A4.6  register a pool whose fee is NOT 5% (0.25%): only the fee MODE is checked, not the fee level
  {
    const w = await makeWorld({ name: "a4-fee", params: {} });
    let ok = false, err = "";
    try { await w.withPool(300_000_000n, 30n * SOL, 25); ok = true; } catch (e) { err = errText(e).slice(0, 160); }
    recordKnown("A4.6", "owner registers a pool with a 0.25% fee (instead of 5%): register_pool only checks pair + 'fee only in B', not the fee level", ok, "ACCEPTED", ok ? "accepted — 'constant 5%' is a launch-procedure promise, not something the contract enforces (the fee schedule/level is not read; decision 2026-09-30: stays as it is)" : err);
  }

  finish("audit/results_a4.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
