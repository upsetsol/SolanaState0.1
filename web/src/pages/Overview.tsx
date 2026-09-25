import React from "react";
import { PublicKey } from "@solana/web3.js";
import { useApp } from "../lib/ctx";
import { fmtDur, fmtRaw, short, tsFmt } from "../lib/chain";
import { Badge, Card, Copy, Kv, Note } from "../lib/ui";

export default function Overview() {
  const { data, settings, active, mint, P } = useApp();
  const c = data.config;
  const dec = data.mintInfo?.decimals ?? 9;
  const tdec = data.treasuryDecimals;
  const sym = data.treasurySymbol;
  if (!mint) return <Note kind="warn">Токен не выбран. Перейдите на вкладку «Настройка» и создайте или вставьте токен.</Note>;
  if (!data.mintInfo) return <Note kind="warn">Токен {short(mint)} не найден в этой сети. Проверьте сеть и адрес на вкладке «Настройка».</Note>;
  if (!c) return <Note kind="warn">Государство для этого токена ещё не инициализировано. Пройдите мастер на вкладке «Настройка».</Note>;

  const supply = data.mintInfo.supply;
  const treasury = data.treasury ?? 0n;
  const inPool = data.pool?.vault ?? 0n; // coins sitting in the pool vault cannot vote
  const circulating = supply > inPool ? supply - inPool : 0n;
  const bps = (n: any) => `${Number(n.toString()) / 100}%`;
  const need = (q: any) => (circulating * BigInt(q.toString())) / 10000n;
  const role = (k: PublicKey) => (k.equals(PublicKey.default) ? <Badge>вакантно</Badge> : <Copy text={k.toBase58()}>{short(k)}</Copy>);
  const dayNow = Math.floor(data.now / 86400);
  const snapDay = Number(c.treasurySnapshotDay.toString());
  const lastSpend = Number(c.lastSpendTs.toString());
  const cool = Number(c.spendCooldownSecs.toString());
  const coolLeft = lastSpend ? Math.max(0, lastSpend + cool - data.now) : 0;

  return (
    <>
      <div className="tiles">
        <div className="tile"><span>Казна ({sym})</span><b>{fmtRaw(treasury, tdec)}</b></div>
        <div className="tile"><span>Фонд вех ({sym})</span><b>{data.fund === null ? "не создан" : fmtRaw(data.fund, tdec)}</b></div>
        <div className="tile"><span>Зарезервировано под вехи</span><b>{fmtRaw(c.milestoneReserved, tdec)}</b></div>
        <div className="tile"><span>Голосуют (выпуск − монеты в пуле)</span><b>{fmtRaw(circulating, dec)}</b></div>
        <div className="tile"><span>Комиссия пула ждёт сбора</span><b>{data.pool?.pending === null || data.pool === null ? "—" : fmtRaw(data.pool.pending, tdec)}</b></div>
        <div className="tile"><span>Пауза</span><b className={c.paused ? "bad" : "good"}>{c.paused ? "ВКЛЮЧЕНА" : "выключена"}</b></div>
        <div className="tile"><span>Мой баланс</span><b>{data.myTokens === null ? "—" : fmtRaw(data.myTokens, dec)}</b></div>
      </div>

      <div className="grid2">
        <Card title="Роли">
          <Kv k="owners_authority (снимки, исполнение)" v={<Copy text={c.ownersAuthority.toBase58()}>{short(c.ownersAuthority)}</Copy>} />
          <Kv k="admin_authority (пауза, порог гражданина)" v={<Copy text={c.adminAuthority.toBase58()}>{short(c.adminAuthority)}</Copy>} />
          <Kv k="Президент" v={role(c.president)} />
          <Kv k="Министр финансов" v={role(c.financeMinister)} />
          <Kv k="Министр культуры" v={role(c.cultureMinister)} />
          {active && <Kv k="Вы" v={<Copy text={active.publicKey.toBase58()}>{short(active.publicKey)}</Copy>} />}
        </Card>

        <Card title="Правила голосования">
          <Kv k="Голосование" v={fmtDur(Number(c.votingPeriodSecs.toString()))} />
          <Kv k="Ожидание перед исполнением" v={fmtDur(Number(c.timelockSecs.toString()))} />
          <Kv k="Президент исполняет, если owner молчит" v={`через ${fmtDur(Number(c.execFallbackSecs.toString()))}`} />
          <Kv k="Порог создания предложения" v={`${bps(c.proposalThresholdBps)} ≈ ${fmtRaw(need(c.proposalThresholdBps), dec)}`} />
          <Kv k="Кворум: траты" v={`${bps(c.quorumSpendBps)} ≈ ${fmtRaw(need(c.quorumSpendBps), dec)}`} />
          <Kv k="Кворум: роли" v={`${bps(c.quorumRoleBps)} ≈ ${fmtRaw(need(c.quorumRoleBps), dec)}`} />
          <Kv k="Кворум: параметры и owner" v={`${bps(c.quorumParamBps)} ≈ ${fmtRaw(need(c.quorumParamBps), dec)}`} />
          <Kv k="Предложений создано" v={c.proposalCount.toString()} />
        </Card>

        <Card title="Деньги и лимиты">
          <Kv k="Пауза между тратами" v={fmtDur(cool)} />
          <Kv k="Последняя трата исполнена" v={lastSpend ? `${tsFmt(lastSpend)}${coolLeft ? ` (ещё ${fmtDur(coolLeft)} до следующей)` : " (можно следующую)"}` : "ещё не было"} />
          <Kv k="Утренний снимок казны" v={snapDay === 0 ? "ещё не делался (создастся при первой зарплате или трате)" : `${fmtRaw(c.treasurySnapshotAmount, tdec)} ${sym} (${snapDay === dayNow ? "сегодняшний" : "вчерашний: обновится при первом действии"})`} />
          <Kv k="Зарплата президента / день" v={bps(c.payrollPresidentBps)} />
          <Kv k="Зарплата минфина / день" v={bps(c.payrollFinanceBps)} />
          <Kv k="Зарплата минкульта / день" v={bps(c.payrollCultureBps)} />
          <Kv k="Минфин: день / неделя" v={`${bps(c.financeDailyBps)} / ${bps(c.financeWeeklyBps)}`} />
          <Kv k="Минкульт: день / неделя" v={`${bps(c.cultureDailyBps)} / ${bps(c.cultureWeeklyBps)}`} />
        </Card>

        <Card title="Вехи и граждане">
          <Kv k="Порог гражданина" v={`${bps(c.citizenshipThresholdBps)} выпуска ≈ ${fmtRaw((supply * BigInt(c.citizenshipThresholdBps.toString())) / 10000n, dec)}`} />
          <Kv k="Потолок депозита в фонд за раз" v={`${bps(c.milestoneDepositBps)} казны`} />
          <Kv k="Срок выплат по вехе" v={fmtDur(Number(c.milestoneGraceSecs.toString()))} />
          <Kv k="Следующая веха №" v={c.nextMilestoneNumber.toString()} />
        </Card>

        <Card title="Токен">
          <Kv k="Адрес" v={<Copy text={mint.toBase58()}>{short(mint)}</Copy>} />
          <Kv k="Выпуск" v={fmtRaw(supply, dec)} />
          <Kv k="Налог на перевод" v="нет (казну наполняет комиссия пула)" />
          <Kv k="Выпускать новые монеты может" v={data.mintInfo.mintAuthority ? short(data.mintInfo.mintAuthority) : "никто"} />
        </Card>

        <Card title="Пул Meteora (источник казны)">
          {data.pool ? (
            <>
              <Kv k="Пул" v={<Copy text={data.pool.pool.toBase58()}>{short(data.pool.pool)}</Copy>} />
              <Kv k="Позиция (владеет Config PDA)" v={<Copy text={data.pool.position.toBase58()}>{short(data.pool.position)}</Copy>} />
              <Kv k="Комиссия пула" v="5% с каждой сделки, только в активе казны; Meteora берёт 20% от неё" />
              <Kv k="Ждёт сбора" v={data.pool.pending === null ? "—" : `${fmtRaw(data.pool.pending, tdec)} ${sym}`} />
              <Kv k="Монет государства в пуле" v={data.pool.vault === null ? "—" : fmtRaw(data.pool.vault, dec)} />
            </>
          ) : (
            <p className="muted">Пул ещё не привязан (вкладка «Настройка», шаг 3.5).</p>
          )}
        </Card>

        <Card title="Сеть">
          <Kv k="RPC" v={settings.rpc} mono />
          <Kv k="Время сети" v={tsFmt(data.now)} />
          <Kv k="Config PDA" v={P ? <Copy text={P.config.toBase58()}>{short(P.config)}</Copy> : "—"} />
          <Kv k="Казна (счёт)" v={P ? <Copy text={P.treasury.toBase58()}>{short(P.treasury)}</Copy> : "—"} />
          <Kv k="Актив казны" v={P ? <Copy text={P.treasuryMint.toBase58()}>{sym === "SOL" ? "wSOL" : short(P.treasuryMint)}</Copy> : "—"} />
          <Kv k="Фонд вех (счёт)" v={P ? <Copy text={P.milestoneFund.toBase58()}>{short(P.milestoneFund)}</Copy> : "—"} />
        </Card>
      </div>
    </>
  );
}
