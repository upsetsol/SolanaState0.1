import React, { useEffect, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { useApp } from "../lib/ctx";
import {
  ATAP, BN, METEORA, METEORA_EVENT_AUTHORITY, METEORA_POOL_AUTHORITY, TP, TPT, fmtDur, fmtRaw, pk, readPoolVaults, toRaw, tsFmt,
} from "../lib/chain";
import { Badge, Btn, Card, Field, Kv, Note, TextIn } from "../lib/ui";

export default function Money() {
  const { data, mint } = useApp();
  if (!mint || !data.config) return <Note kind="warn">Сначала запустите государство (вкладка «Настройка»).</Note>;
  return (
    <>
      <Salary />
      <MinisterSpend />
      <ClaimFees />
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
  const { data, active, run, program, readProgram, rpcOpts, P } = useApp();
  const dec = data.treasuryDecimals;
  const c = data.config;
  // the "already paid today" record is kept per ROLE (0 president, 1 finance, 2 culture), not per wallet
  let role = "", bps = 0, roleNum = -1;
  if (active) {
    if (c.president.equals(active.publicKey)) { role = "президент"; roleNum = 0; bps = Number(c.payrollPresidentBps.toString()); }
    else if (c.financeMinister.equals(active.publicKey)) { role = "министр финансов"; roleNum = 1; bps = Number(c.payrollFinanceBps.toString()); }
    else if (c.cultureMinister.equals(active.publicKey)) { role = "министр культуры"; roleNum = 2; bps = Number(c.payrollCultureBps.toString()); }
  }
  const claim = useFetched(
    () => (active && P && roleNum >= 0 ? readProgram.account.payrollClaim.fetchNullable(P.payroll(roleNum)) : Promise.resolve(null)),
    [active?.publicKey.toBase58(), P?.config.toBase58(), roleNum, data.now > 0 ? Math.floor(data.now / 5) : 0]
  );
  const snapDay = Number(c.treasurySnapshotDay.toString());
  const base = snapDay === Math.floor(data.now / 86400) ? BigInt(c.treasurySnapshotAmount.toString()) : (data.treasury ?? 0n);
  const payout = (base * BigInt(bps)) / 10000n;
  const last = claim ? Number(claim.lastClaimTs.toString()) : 0;
  const nextAt = last ? last + 86400 : 0;

  const go = () =>
    run("Забрать зарплату", () =>
      program.methods
        .claimSalary(roleNum)
        .accounts({
          claimant: active!.publicKey, config: P!.config, treasuryMint: P!.treasuryMint, payrollClaim: P!.payroll(roleNum),
          treasury: P!.treasury, claimantTokenAccount: P!.tAta(active!.publicKey), tokenProgram: TPT, systemProgram: SystemProgram.programId,
        })
        .preInstructions([
          createAssociatedTokenAccountIdempotentInstruction(active!.publicKey, P!.tAta(active!.publicKey), active!.publicKey, P!.treasuryMint, TPT, ATAP),
        ])
        .rpc(rpcOpts())
    );

  return (
    <Card title="Зарплата" right={<Btn kind="primary" onClick={go} disabled={!active}>Забрать зарплату</Btn>}>
      <p className="muted">Раз в сутки, процент от «утреннего снимка» казны (не от текущего баланса). Получить может президент и министры, каждый за свою роль. Выплата приходит в активе казны ({data.treasurySymbol}).</p>
      <div className="kvs">
        <Kv k="Активный кошелёк" v={role ? <Badge kind="ok">{role}</Badge> : <Badge kind="warn">без роли: контракт откажет</Badge>} />
        <Kv k="Ставка" v={role ? `${bps / 100}% в день` : "—"} />
        <Kv k="База (снимок казны)" v={`${fmtRaw(base, dec)} ${data.treasurySymbol}`} />
        <Kv k="Ожидаемая выплата" v={role ? `${fmtRaw(payout, dec)} ${data.treasurySymbol}` : "—"} />
        <Kv k="Последний раз" v={last ? tsFmt(last) : "не получал"} />
        <Kv k="Следующая доступна" v={last ? (data.now >= nextAt ? "уже можно" : `через ${fmtDur(nextAt - data.now)}`) : "сразу"} />
      </div>
    </Card>
  );
}

function MinisterSpend() {
  const { data, active, run, program, readProgram, rpcOpts, P } = useApp();
  const dec = data.treasuryDecimals;
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
          minister: active!.publicKey, config: P!.config, treasuryMint: P!.treasuryMint, spendTracker: P!.tracker(role),
          treasury: P!.treasury, recipientTokenAccount: P!.tAta(pk(to || me)), tokenProgram: TPT, systemProgram: SystemProgram.programId,
        })
        .preInstructions([
          createAssociatedTokenAccountIdempotentInstruction(active!.publicKey, P!.tAta(pk(to || me)), pk(to || me), P!.treasuryMint, TPT, ATAP),
        ])
        .rpc(rpcOpts())
    );

  return (
    <Card title="Трата министра (без голосования, в пределах лимита)">
      <p className="muted">Лимит считается по РОЛИ, а не по кошельку: смена министра не сбрасывает окно. Лимиты: процент от утреннего снимка казны. Сумма в активе казны ({data.treasurySymbol}), счёт получателя создаётся автоматически.</p>
      <div className="row">
        <Field label="Роль">
          <select value={role} onChange={(e) => setRole(Number(e.target.value))}>
            <option value={1}>1: министр финансов</option>
            <option value={2}>2: министр культуры</option>
          </select>
        </Field>
        <Field label={`Сумма, ${data.treasurySymbol}`}><TextIn value={amount} onChange={setAmount} /></Field>
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

function ClaimFees() {
  const { data, run, program, connection, rpcOpts, P, mint, active } = useApp();
  const dec = data.treasuryDecimals;
  const sym = data.treasurySymbol;
  const pool = data.pool;

  const claim = () =>
    run("Забрать комиссию пула в казну", async () => {
      if (!P || !mint || !pool) throw new Error("Пул не привязан");
      const { vaultA, vaultB } = await readPoolVaults(connection, pool.pool);
      return program.methods
        .claimPoolFees()
        .accounts({
          caller: active!.publicKey, config: P.config, governanceMint: mint, treasuryMint: P.treasuryMint, treasury: P.treasury,
          feeAAccount: P.feeA, poolAuthority: METEORA_POOL_AUTHORITY, pool: pool.pool, position: pool.position,
          tokenAVault: vaultA, tokenBVault: vaultB, positionNftAccount: data.config.feePositionNftAccount,
          tokenAProgram: TP, tokenBProgram: TPT, eventAuthority: METEORA_EVENT_AUTHORITY, meteoraProgram: METEORA,
        })
        .rpc(rpcOpts());
    });

  return (
    <Card title="Комиссия пула → казна" right={<Btn kind="primary" onClick={claim} disabled={!active || !pool}>Забрать комиссию</Btn>}>
      <p className="muted">
        5% с каждой покупки и продажи в пуле удерживаются самим пулом в активе казны и копятся на позиции. Забрать их в казну может любой:
        одна обычная транзакция, получатель зашит в контракте. Ничего не сгорает и не устаревает, бот не нужен.
      </p>
      <Kv k="Казна сейчас" v={`${fmtRaw(data.treasury, dec)} ${sym}`} />
      {pool ? (
        <>
          <Kv k="Комиссия ждёт сбора" v={pool.pending === null ? "—" : `${fmtRaw(pool.pending, dec)} ${sym}`} />
          <Kv k="Монет государства в пуле (не голосуют)" v={pool.vault === null ? "—" : fmtRaw(pool.vault, data.mintInfo!.decimals)} />
        </>
      ) : (
        <Note kind="warn">Пул ещё не привязан (вкладка «Настройка», шаг 3.5).</Note>
      )}
    </Card>
  );
}
