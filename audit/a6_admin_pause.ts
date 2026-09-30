// A6 — the single-key powers: admin_authority (pause / citizenship threshold) and the missing rotation paths.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/a6_admin_pause.ts
import { Keypair, PublicKey } from "@solana/web3.js";
import { makeWorld, group, record, recordKnown, IDL, anchor, finish, errText, SOL } from "./lib";

async function main() {
  group("A6 admin / pause / key rotation");
  const w = await makeWorld({ name: "a6", params: { cooldown: 0 } });
  const A = await w.holder(200_000_000n, 20);
  const B = await w.holder(60_000_000n, 20);
  const newOwner = Keypair.generate().publicKey;

  // a proposal the community really passed: hand owners_authority to someone else
  const p = await w.propose(5, newOwner, 0, 0, "rotate the owner key");
  await w.snapshot(p.id, p.pPda, A.publicKey);
  await w.snapshot(p.id, p.pPda, B.publicKey);
  await w.openVoting(p.id);
  await w.vote(A, p.id, p.pPda, true);
  await w.vote(B, p.id, p.pPda, true);
  await w.waitExecutable(p.pPda);

  // A6.1 the admin key freezes ALL governance execution (not only money): role/param/owner changes too
  await w.program.methods.setPause(true).accounts({ admin: w.me, config: w.configPda }).rpc();
  let frozen = false, why = "";
  try { await w.execute(p.id); } catch (e) { why = errText(e); frozen = /Paused/.test(why); }
  recordKnown("A6.1", "admin sets pause → even a fully passed governance vote (owner rotation) cannot be executed", frozen, "ACCEPTED", `execute → Paused=${frozen}; nothing but the admin key can lift it (decision 2026-09-30: the admin is one person, as it is)`);

  // A6.2 there is NO instruction that rotates / removes the admin (or that anybody but the admin can use to unpause)
  const mutators = IDL.instructions.filter((i: any) => i.args.some((a: any) => /admin/i.test(a.name)) && i.name !== "initialize").map((i: any) => i.name);
  const unpause = IDL.instructions.filter((i: any) => i.name === "set_pause").length;
  if (mutators.length === 0) recordKnown("A6.2", "instructions able to change admin_authority after initialize", true, "ACCEPTED",
    `none found in the IDL (set_pause/set_citizenship_threshold only READ the admin). A lost, stolen or hostile admin key can never be replaced → permanent freeze is possible; there are ${unpause} pause instruction(s), admin-only`);
  else record("A6.2", "instructions able to change admin_authority after initialize", "INFO", mutators.join(", "));

  // A6.3 …and there is no way for the community to route around it: the executor is owner/president, both are blocked by the pause
  await w.program.methods.setPause(false).accounts({ admin: w.me, config: w.configPda }).rpc();

  // A6.4 the admin can also kill milestone payouts by raising the citizenship threshold to 100% of supply
  await w.fundMilestoneDirect(SOL);
  const ms = await w.createMilestone();
  await w.program.methods.setCitizenshipThreshold(new anchor.BN(10_000)).accounts({ admin: w.me, config: w.configPda }).rpc();
  let noCitizens = false;
  try { await w.msSnap(ms.n, ms.m, A.publicKey); } catch (e) { noCitizens = /BelowCitizenshipThreshold/.test(errText(e)); }
  await w.program.methods.setCitizenshipThreshold(new anchor.BN(25)).accounts({ admin: w.me, config: w.configPda }).rpc();
  recordKnown("A6.4", "admin raises the citizenship threshold to 100% → no holder can be snapshotted for a milestone (payouts blocked)", noCitizens, "ACCEPTED", `20% whale rejected with BelowCitizenshipThreshold=${noCitizens}`);

  // A6.5 with the pause lifted, the same vote executes: the owner key changes hands (control check)
  let ok = false;
  try { await w.execute(p.id); ok = true; } catch (e) { /* */ }
  const cfg = await w.cfg();
  record("A6.5", "control: after unpausing, the passed vote executes and owners_authority changes", ok && (cfg.ownersAuthority as PublicKey).equals(newOwner) ? "OK" : "ERROR", `owners_authority now ${(cfg.ownersAuthority as PublicKey).toBase58().slice(0, 8)}…`);

  // A6.6 after that rotation the OLD owner can no longer post snapshots and the NEW key (nobody holds it) blocks all voting
  let stuck = false;
  try {
    const q = await w.propose(4, w.me, 60, 5, "any proposal");
    try { await w.snapshot(q.id, q.pPda, A.publicKey); } catch (e) { stuck = /NotOwner/.test(errText(e)); }
  } catch (e) { /* */ }
  recordKnown("A6.6", "if owners_authority is rotated to a key nobody controls (typo / lost key): no snapshots → no votes ever again", stuck, "ACCEPTED", "president can still execute old approved votes after the fallback, but no NEW vote can ever be opened; recovery only by upgrading the program");

  finish("audit/results_a6.json");
}
main().catch((e) => { console.error(e); process.exit(1); });
