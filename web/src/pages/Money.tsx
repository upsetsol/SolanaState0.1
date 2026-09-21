import React, { useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useApp } from "../lib/ctx";
import { BN, TP, fmtDur, fmtRaw, pk, short, toRaw, tsFmt } from "../lib/chain";
import { Badge, Btn, Card, Field, Kv, Note, TextIn } from "../lib/ui";

export default function Money() {
  const { data, mint } = useApp();
  if (!mint || !data.config) return <Note kind="warn">Сначала запустите государство (вкладка «Настройка»).</Note>;
  return (
    <>
      <Salary />
      <MinisterSpend />
      <Harvest />
    </>
  );
}

function useFetched(fn: () => Promise<any>, deps: unknown[]): any {
  const [v, setV] = useState<any>(null);
  useEffect(() => {
    let dead = false;
    fn().then((x) => !dead && setV(x)).catch(() => !dead && setV(null));
    return () => { dead = true; };
  }, deps);
  return v;
}

function Salary() {
  const { data, active, run, program, readProgram, rpcOpts, P, mint } = useApp();
  const dec = data.mintInfo!.decimals;
  const c = data.config;
  const claim = useFetched(
    () => (active && P ? readProgram.account.payrollClaim.fetchNullable(P.payroll(active.publicKey)) : Promise.resolve(null)),
    [active?.publicKey.toBase58(), P?.config.toBase58(), data.now > 0 ? Math.floor(data.now / 5) : 0]
  );
  let role = "", bps = 0;
  if (active) {
    if (c.president.equals(active.publicKey)) { role = "президент"; bps = Number(c.payrollPresidentBps.toString()); }
    else if (c.financeMinister.equals(active.publicKey)) { role = "министр финансов"; bps = Number(c.payrollFinanceBps.toString()); }
    else if (c.cultureMinister.equals(active.publicKey)) { role = "министр культуры"; bps = Number(c.payrollCultureBps.toString()); }
  }
  const snapDay = Number(c.treasurySnapshotDay.toString());
  const base = snapDay === Math.floor(data.now / 86400) ? BigInt(c.treasurySnapshotAmount.toString()) : (data.treasury ?? 0n);
  const payout = (base * BigInt(bps)) / 10000n;
  const last = claim ? Number(claim.lastClaimTs.toString()) : 0;
  const nextAt = last ? last + 86400 : 0;

  const go = () =>
    run("Забрать зарплату", () =>
      program.methods
        .claimSalary()
        .accounts({
          claimant: active!.publicKey, governanceMint: mint!, config: P!.config, payrollClaim: P!.payroll(active!.publicKey),
          treasury: P!.treasury, claimantTokenAccount: P!.ata(active!.publicKey), tokenProgram: TP, systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOpts())
    );

  return (
    <Card title="Зарплата" right={<Btn kind="primary" onClick={go} disabled={!active}>Забрать зарплату</Btn>}>
      <p className="muted">Раз в сутки, процент от «утреннего снимка» казны (не от текущего баланса). Получить может президент и министры, каждый за свою роль. Получатель получает сумму за вычетом налога.</p>
      <div className="kvs">
        <Kv k="Активный кошелёк" v={role ? <Badge kind="ok">{role}</Badge> : <Badge kind="warn">без роли: контракт откажет</Badge>} />
        <Kv k="Ставка" v={role ? `${bps / 100}% в день` : "—"} />
        <Kv k="База (снимок казны)" v={fmtRaw(base, dec)} />
        <Kv k="Ожидаемая выплата (до налога)" v={role ? fmtRaw(payout, dec) : "—"} />
        <Kv k="Последний раз" v={last ? tsFmt(last) : "не получал"} />
        <Kv k="Следующая доступна" v={last ? (data.now >= nextAt ? "уже можно" : `через ${fmtDur(nextAt - data.now)}`) : "сразу"} />
      </div>
    </Card>
  );
}

function MinisterSpend() {
  const { data, active, run, program, readProgram, rpcOpts, P, mint } = useApp();
  const dec = data.mintInfo!.decimals;
  const c = data.config;
  const [role, setRole] = useState(1);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("Реклама");
  const tr = useFetched(() => (P ? readProgram.account.spendTracker.fetchNullable(P.tracker(role)) : Promise.resolve(null)), [role, P?.config.toBase58(), Math.floor(data.now / 5)]);
  const isMin = active && (role === 1 ? c.financeMinister : c.cultureMinister).equals(active.publicKey);
  const dBps = Number((role === 1 ? c.financeDailyBps : c.cultureDailyBps).toString());
  const wBps = Number((role === 1 ? c.financeWeeklyBps : c.cultureWeeklyBps).toString());
  const snapDay = Number(c.treasurySnapshotDay.toString());
  const base = snapDay === Math.floor(data.now / 86400) ? BigInt(c.treasurySnapshotAmount.toString()) : (data.treasury ?? 0n);
  const dCap = (base * BigInt(dBps)) / 10000n;
  const wCap = (base * BigInt(wBps)) / 10000n;
  const dStart = tr ? Number(tr.dailyWindowStart.toString()) : 0;
  const wStart = tr ? Number(tr.weeklyWindowStart.toString()) : 0;
  const dSpent = tr && data.now - dStart < 86400 ? BigInt(tr.dailySpent.toString()) : 0n;
  const wSpent = tr && data.now - wStart < 604800 ? BigInt(tr.weeklySpent.toString()) : 0n;
  const me = active?.publicKey.toBase58() ?? "";

  const go = () =>
    run(`Трата министра (роль ${role})`, () =>
      program.methods
        .ministerSpend(role, toRaw(amount || "0", dec), reason)
        .accounts({
          minister: active!.publicKey, governanceMint: mint!, config: P!.config, spendTracker: P!.tracker(role),
          treasury: P!.treasury, recipientTokenAccount: P!.ata(pk(to || me)), tokenProgram: TP, systemProgram: SystemProgram.programId,
        })
        .rpc(rpcOpts())
    );

  return (
    <Card title="Трата министра (без голосования, в пределах лимита)">
      <p className="muted">Лимит считается по РОЛИ, а не по кошельку: смена министра не сбрасывает окно. Лимиты: процент от утреннего снимка казны. Счёт получателя должен уже существовать.</p>
      <div className="row">
        <Field label="Роль">
          <select value={role} onChange={(e) => setRole(Number(e.target.value))}>
            <option value={1}>1: министр финансов</option>
            <option value={2}>2: министр культуры</option>
          </select>
        </Field>
        <Field label="Сумма, токенов"><TextIn value={amount} onChange={setAmount} /></Field>
        <Field label="Получатель" hint="Пусто = активный кошелёк"><TextIn mono value={to} onChange={setTo} placeholder={me} /></Field>
        <Field label="Причина (обязательна)"><TextIn value={reason} onChange={setReason} /></Field>
        <div className="row end"><Btn kind="primary" onClick={go} disabled={!active}>Потратить</Btn></div>
      </div>
      <div className="kvs">
        <Kv k="Активный кошелёк это министр этой роли?" v={isMin ? <Badge kind="ok">да</Badge> : <Badge kind="warn">нет: контракт откажет</Badge>} />
        <Kv k="Лимит в день" v={`${dBps / 100}% ≈ ${fmtRaw(dCap, dec)}`} />
        <Kv k="Потрачено за текущий день" v={fmtRaw(dSpent, dec)} />
        <Kv k="Лимит в неделю" v={`${wBps / 100}% ≈ ${fmtRaw(wCap, dec)}`} />
        <Kv k="Потрачено за текущую неделю" v={fmtRaw(wSpent, dec)} />
      </div>
    </Card>
  );
}

function Harvest() {
  const { data, run, program, rpcOpts, P, mint, scanWithheld, active } = useApp();
  const dec = data.mintInfo!.decimals;
  const [found, setFound] = useState<{ account: PublicKey; withheld: bigint }[] | null>(null);

  const scan = async () => setFound(await scanWithheld());
  const harvest = async () => {
    const list = found ?? (await scanWithheld());
    if (!list.length) { alert("Налога для сбора нет."); return; }
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20);
      const r = await run(`Собрать налог (${chunk.length} счетов)`, () =>
        program.methods
          .harvestFees()
          .accounts({ governanceMint: mint!, config: P!.config, treasury: P!.treasury, tokenProgram: TP })
          .remainingAccounts(chunk.map((c) => ({ pubkey: c.account, isWritable: true, isSigner: false })))
          .rpc(rpcOpts())
      );
      if (!r.ok) break;
    }
    setFound(null);
  };
  const total = (found ?? []).reduce((a, b) => a + b.withheld, 0n);

  return (
    <Card title="Сбор налога в казну" right={<><button onClick={scan}>Найти налог</button> <Btn kind="primary" onClick={harvest} disabled={!active}>Собрать</Btn></>}>
      <p className="muted">Налог с каждого перевода откладывается на токен-счетах. Любой может запустить сбор: налог уйдёт в казну. Сам он не запускается (нужен бот).</p>
      <Kv k="Казна сейчас" v={fmtRaw(data.treasury, dec)} />
      {found && (
        <>
          <Kv k="Найдено налога к сбору" v={`${fmtRaw(total, dec)} на ${found.length} счетах`} />
          {found.map((f) => <div key={f.account.toBase58()} className="muted mono">{short(f.account)}: {fmtRaw(f.withheld, dec)}</div>)}
        </>
      )}
    </Card>
  );
}
