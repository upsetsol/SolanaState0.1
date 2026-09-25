import React, { useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { useApp } from "../lib/ctx";
import { ATAP, BN, TPT, fmtDur, fmtRaw, pk, short, tsFmt } from "../lib/chain";
import { Badge, Btn, Card, Copy, Field, Kv, Note, TextIn } from "../lib/ui";

export default function Milestones() {
  const { data, mint, P, active, run, program, rpcOpts, readProgram } = useApp();
  const [recs, setRecs] = useState<{ n: number; pda: PublicKey; d: any }[]>([]);
  const [snaps, setSnaps] = useState<any[]>([]);
  const c = data.config;
  const next = c ? Number(c.nextMilestoneNumber.toString()) : 1;

  useEffect(() => {
    let dead = false;
    (async () => {
      if (!P || !c) return;
      const list = Array.from({ length: next - 1 }, (_, i) => i + 1);
      const pdaList = list.map((n) => P.milestone(n));
      const rows = list.length ? await readProgram.account.milestoneRecord.fetchMultiple(pdaList) : [];
      const all = list.length ? await readProgram.account.milestoneSnapshot.all() : [];
      if (!dead) {
        setRecs(rows.map((d: any, i: number) => ({ n: list[i], pda: pdaList[i], d })).filter((r: any) => r.d));
        setSnaps(all);
      }
    })().catch(() => {});
    return () => { dead = true; };
  }, [P?.config.toBase58(), next, data.now > 0 ? Math.floor(data.now / 6) : 0]);

  if (!mint || !c) return <Note kind="warn">Сначала запустите государство (вкладка «Настройка»).</Note>;
  const dec = data.treasuryDecimals; // fund and payouts are in the treasury asset
  const noFund = c.milestoneFundTokenAccount.equals(PublicKey.default);

  const create = () =>
    run("Создать веху", () =>
      program.methods
        .createMilestone()
        .accounts({ owner: active!.publicKey, config: P!.config, milestoneRecord: P!.milestone(next), systemProgram: SystemProgram.programId })
        .rpc(rpcOpts())
    );

  return (
    <>
      <Card title="Вехи: награды гражданам" right={<Btn kind="primary" onClick={create} disabled={!active || noFund}>Создать веху №{next}</Btn>}>
        <p className="muted">
          Граждане = держатели не меньше порога ({Number(c.citizenshipThresholdBps.toString()) / 100}% выпуска). Веху объявляет owner вручную. Порядок: пополнить фонд (предложение типа «Пополнить фонд вех») → создать веху → внести снимки граждан → закрыть веху → выплатить каждому → по истечении срока вернуть остаток в фонд.
        </p>
        {noFund && <Note kind="warn">Фонд вех не создан (вкладка «Настройка», шаг 3.4).</Note>}
        <Kv k="В фонде" v={data.fund === null ? "—" : fmtRaw(data.fund, dec)} />
        <Kv k="Зарезервировано под невыплаченные вехи" v={fmtRaw(c.milestoneReserved, dec)} />
        <Kv k="Свободно для следующей вехи" v={data.fund === null ? "—" : fmtRaw(data.fund > BigInt(c.milestoneReserved.toString()) ? data.fund - BigInt(c.milestoneReserved.toString()) : 0n, dec)} />
      </Card>
      {[...recs].reverse().map((r) => (
        <MilestoneCard key={r.n} n={r.n} pda={r.pda} d={r.d} snaps={snaps.filter((s) => P!.mSnap(r.pda, s.account.holder).equals(s.publicKey))} />
      ))}
    </>
  );
}

function MilestoneCard({ n, pda, d, snaps }: { n: number; pda: PublicKey; d: any; snaps: any[] }) {
  const { data, active, run, program, rpcOpts, P, mint, scanHolders } = useApp();
  const c = data.config;
  const dec = data.treasuryDecimals; // pool, shares and payouts: treasury asset
  const gdec = data.mintInfo!.decimals; // holders' weights: the voting coin
  const [who, setWho] = useState("");
  const [claimTo, setClaimTo] = useState("");
  const pool = (BigInt(d.fundSnapshotAmount.toString()) * BigInt(d.payoutBps.toString())) / 10000n;
  const total = BigInt(d.totalEligibleWeight.toString());
  const grace = Number(c.milestoneGraceSecs.toString());
  const finAt = Number(d.finalizedAt.toString());
  const graceLeft = d.finalized ? finAt + grace - data.now : 0;
  const me = active?.publicKey.toBase58() ?? "";
  const supply = data.mintInfo!.supply;

  const snap = (holder: PublicKey) =>
    program.methods
      .postMilestoneSnapshot(new BN(n), holder)
      .accounts({
        owner: active!.publicKey, config: P!.config, governanceMint: mint!, milestoneRecord: pda,
        holderTokenAccount: P!.ata(holder), milestoneSnapshot: P!.mSnap(pda, holder), systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());

  const snapEligible = async () => {
    const holders = await scanHolders();
    const thr = BigInt(c.citizenshipThresholdBps.toString());
    const eligible = holders.filter((h) => h.amount * 10000n >= supply * thr);
    if (!eligible.length) { alert("Подходящих держателей не найдено."); return; }
    for (const h of eligible) {
      if (snaps.some((s) => s.account.holder.equals(h.owner))) continue;
      const r = await run(`Снимок гражданина ${short(h.owner)} (${fmtRaw(h.amount, gdec)})`, () => snap(h.owner));
      if (!r.ok) break;
    }
  };

  const finalize = () =>
    run(`Закрыть веху №${n}`, () =>
      program.methods
        .finalizeMilestone(new BN(n))
        .accounts({
          owner: active!.publicKey, config: P!.config, milestoneRecord: pda,
          previousMilestone: n > 1 ? P!.milestone(n - 1) : null, milestoneFund: P!.milestoneFund,
        })
        .rpc(rpcOpts())
    );

  const release = () =>
    run(`Вернуть остаток вехи №${n} в фонд`, () =>
      program.methods
        .releaseMilestoneReserve(new BN(n))
        .accounts({ owner: active!.publicKey, config: P!.config, milestoneRecord: pda })
        .rpc(rpcOpts())
    );

  const pay = (holder: PublicKey) =>
    run(`Выплата по вехе №${n} → ${short(holder)}`, () =>
      program.methods
        .claimMilestone(new BN(n), holder)
        .accounts({
          payer: active!.publicKey, config: P!.config, treasuryMint: P!.treasuryMint, milestoneRecord: pda,
          milestoneSnapshot: P!.mSnap(pda, holder), milestoneFund: P!.milestoneFund, claimantTokenAccount: P!.tAta(holder), tokenProgram: TPT,
        })
        .preInstructions([
          createAssociatedTokenAccountIdempotentInstruction(active!.publicKey, P!.tAta(holder), holder, P!.treasuryMint, TPT, ATAP),
        ])
        .rpc(rpcOpts())
    );

  const state = d.released ? <Badge>закрыта, остаток возвращён</Badge> : d.finalized ? <Badge kind="ok">закрыта для снимков, идут выплаты</Badge> : <Badge kind="info">сбор снимков</Badge>;

  return (
    <Card title={<>Веха №{n} {state}</>}>
      <div className="kvs">
        <Kv k="Доля выплаты" v={`${Number(d.payoutBps.toString()) / 100}% от свободной части фонда`} />
        <Kv k="Граждан в снимках" v={snaps.length} />
        <Kv k="Суммарный вес" v={fmtRaw(total, gdec)} />
        <Kv k="Пул к выплате" v={d.finalized ? fmtRaw(pool, dec) : "определится при закрытии"} />
        <Kv k="Уже выплачено" v={fmtRaw(d.claimedAmount, dec)} />
        <Kv k="Закрыта" v={d.finalized ? tsFmt(finAt) : "—"} />
        <Kv k="Остаток можно вернуть" v={d.finalized && !d.released ? (graceLeft > 0 ? `через ${fmtDur(graceLeft)}` : "уже можно") : "—"} />
      </div>

      {!d.finalized && (
        <div className="row">
          <Field label="Адрес гражданина" hint="Нужен баланс не ниже порога; вес читается с токен-счёта">
            <TextIn mono value={who} onChange={setWho} placeholder={me} />
          </Field>
          <div className="row end">
            <Btn onClick={() => run(`Снимок гражданина ${short(who || me)}`, () => snap(pk(who || me)))} disabled={!active}>Внести снимок</Btn>
            <Btn onClick={snapEligible} disabled={!active}>Внести всех подходящих</Btn>
            <Btn kind="primary" onClick={finalize} disabled={!active}>Закрыть веху</Btn>
          </div>
        </div>
      )}
      {d.finalized && !d.released && <div className="row"><Btn onClick={release} disabled={!active}>Вернуть невыплаченный остаток в фонд</Btn></div>}

      {snaps.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Гражданин</th><th>Вес</th><th>Доля</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            {snaps.map((s) => {
              const w = BigInt(s.account.weight.toString());
              const share = total ? (pool * w) / total : 0n;
              return (
                <tr key={s.publicKey.toBase58()}>
                  <td><Copy text={s.account.holder.toBase58()}>{short(s.account.holder)}</Copy></td>
                  <td>{fmtRaw(w, gdec)}</td>
                  <td>{d.finalized ? fmtRaw(share, dec) : "—"}</td>
                  <td>{s.account.claimed ? <Badge kind="ok">выплачено</Badge> : <Badge>ждёт</Badge>}</td>
                  <td><Btn onClick={() => pay(s.account.holder)} disabled={!active || !d.finalized}>Выплатить</Btn></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
