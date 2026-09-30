import React, { useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAccount } from "@solana/spl-token";
import { useApp, ProposalRow } from "../lib/ctx";
import { ATAP, BN, PARAM_KEYS, PROPOSAL_EXEC_WINDOW_SECS, PROPOSAL_TYPES, TP, TPT, fmtDur, fmtRaw, pk, short, toRaw, tsFmt } from "../lib/chain";
import { Badge, Btn, Card, Copy, Field, Kv, Note, TextIn } from "../lib/ui";

export default function Proposals() {
  const app = useApp();
  const { data, mint } = app;
  if (!mint || !data.config) return <Note kind="warn">Сначала запустите государство (вкладка «Настройка»).</Note>;
  return (
    <>
      <Create />
      <Card title={`Предложения (${data.proposals.length})`}>
        {data.proposals.length === 0 && <p className="muted">Предложений пока нет.</p>}
        {[...data.proposals].reverse().map((r) => <Proposal key={r.id} row={r} />)}
      </Card>
    </>
  );
}

function Create() {
  const { active, data, run, program, rpcOpts, P, mint } = useApp();
  const tdec = data.treasuryDecimals;
  const [type, setType] = useState(0);
  const [target, setTarget] = useState("");
  const [amount, setAmount] = useState("");
  const [paramKey, setParamKey] = useState(0);
  const [reason, setReason] = useState("");
  const me = active?.publicKey.toBase58() ?? "";
  const usesTarget = type !== 4 && type !== 6;
  const usesAmountTokens = type === 0 || type === 6;

  const create = async () => {
    if (!active || !mint || !P) throw new Error("Нет кошелька");
    const id = data.config.proposalCount;
    const amt = type === 4 ? new BN(amount || "0") : usesAmountTokens ? toRaw(amount || "0", tdec) : new BN(0);
    const tgt = usesTarget ? pk(target || me) : active.publicKey;
    return program.methods
      .createProposal(type, tgt, amt, type === 4 ? paramKey : 0, reason || PROPOSAL_TYPES[type])
      .accounts({
        creator: active.publicKey, config: P.config, governanceMint: mint, creatorTokenAccount: P.ata(active.publicKey),
        treasury: P.treasury, quorumExcluded: data.pool ? data.config.quorumExcludedAccount : null,
        proposal: P.proposal(id), systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());
  };

  return (
    <Card title="Создать предложение">
      <p className="muted">Создать может любой, кто держит не меньше порога (см. «Обзор»). Кто создаёт, тот платит за аккаунт предложения. Контракт сам проверит ограничения (потолок 30% казны на траты, потолок депозита в фонд и т.д.).</p>
      <div className="row">
        <Field label="Тип">
          <select value={type} onChange={(e) => setType(Number(e.target.value))}>
            {PROPOSAL_TYPES.map((t, i) => <option key={i} value={i}>{i}: {t}</option>)}
          </select>
        </Field>
        {usesTarget && <Field label={type === 0 ? "Получатель" : "Адрес"} hint="Пусто = активный кошелёк"><TextIn mono value={target} onChange={setTarget} placeholder={me} /></Field>}
        {type === 4 && (
          <Field label="Параметр">
            <select value={paramKey} onChange={(e) => setParamKey(Number(e.target.value))}>
              {PARAM_KEYS.map((t, i) => <option key={i} value={i}>{i}: {t}</option>)}
            </select>
          </Field>
        )}
        {(usesAmountTokens || type === 4) && (
          <Field label={type === 4 ? "Новое значение (число)" : `Сумма, ${data.treasurySymbol}`}>
            <TextIn value={amount} onChange={setAmount} placeholder={type === 4 ? "например 80" : "например 1000"} />
          </Field>
        )}
        <Field label="Причина / описание"><TextIn value={reason} onChange={setReason} placeholder={PROPOSAL_TYPES[type]} /></Field>
        <div className="row end"><Btn kind="primary" onClick={() => run(`Создать предложение: ${PROPOSAL_TYPES[type]}`, create)} disabled={!active}>Создать</Btn></div>
      </div>
    </Card>
  );
}

export function stageOf(row: ProposalRow, data: any) {
  const c = data.config;
  const p = row.data;
  const now = data.now;
  const open: boolean = !!p.votingOpen; // the owner calls open_voting after posting the snapshots
  const dl = open ? Number(p.deadline.toString()) : 0;
  const tl = Number(c.timelockSecs.toString());
  const fb = Number(c.execFallbackSecs.toString());
  const unlock = dl + tl;
  const expiresAt = open ? unlock + fb + PROPOSAL_EXEC_WINDOW_SECS : 0;
  // the quorum base was FROZEN when voting opened (supply minus the pool vault balance at that moment)
  const base: bigint = open ? BigInt(p.baseAtOpen.toString()) : 0n;
  const qbps = BigInt((p.proposalType === 0 || p.proposalType === 6 ? c.quorumSpendBps : p.proposalType <= 3 ? c.quorumRoleBps : c.quorumParamBps).toString());
  const vf = BigInt(p.votesFor.toString());
  const va = BigInt(p.votesAgainst.toString());
  const quorum = open && (vf + va) * 10000n >= base * qbps;
  const passed = vf > va;
  let label: string; let kind: "ok" | "warn" | "err" | "info";
  if (p.executed) { label = "Исполнено"; kind = "ok"; }
  else if (!open) { label = "Идёт запись избирателей (голосование ещё не открыто)"; kind = "info"; }
  else if (now <= dl) { label = `Идёт голосование, осталось ${fmtDur(dl - now)}`; kind = "info"; }
  else if (!quorum) { label = "Не набран кворум"; kind = "err"; }
  else if (!passed) { label = "Отклонено"; kind = "err"; }
  else if (now > expiresAt) { label = "Просрочено: не исполнено вовремя"; kind = "err"; }
  else if (now < unlock) { label = `Принято, ждёт исполнения ${fmtDur(unlock - now)}`; kind = "warn"; }
  else { label = "Готово к исполнению"; kind = "ok"; }
  return { label, kind, open, dl, unlock, fallbackAt: unlock + fb, expiresAt, quorum, passed, vf, va, base, qbps, need: (base * qbps) / 10000n };
}

function Proposal({ row }: { row: ProposalRow }) {
  const app = useApp();
  const { data, active, run, program, rpcOpts, P, mint, scanHolders, connection } = app;
  const dec = data.mintInfo!.decimals;
  const tdec = data.treasuryDecimals;
  const p = row.data;
  const s = stageOf(row, data);
  const [who, setWho] = useState("");
  const me = active?.publicKey.toBase58() ?? "";
  const total = s.vf + s.va;
  const pctFor = total ? Number((s.vf * 1000n) / total) / 10 : 0;

  // weight = what the owner's ONE scan saw. The contract only refuses a weight of 0 or above the voter's balance right now,
  // so coins moved to another wallet after the scan cannot be counted twice. A single manual entry uses the balance right now.
  const snapshot = async (voter: PublicKey, weight?: bigint, tokenAccount?: PublicKey) => {
    const acct = tokenAccount ?? P!.ata(voter);
    const w = weight ?? (await getAccount(connection, acct, "confirmed", TP)).amount;
    return program.methods
      .postVoterSnapshot(new BN(row.id), voter, new BN(w.toString()))
      .accounts({
        owner: active!.publicKey, config: P!.config, proposal: row.pda, voterTokenAccount: acct,
        voterSnapshot: P!.snap(row.pda, voter), systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());
  };

  const snapshotAll = async () => {
    const holders = await scanHolders(); // ONE scan: every weight below describes the same moment
    if (!holders.length) { alert("Держателей токена не найдено (или RPC не разрешил поиск). Внесите адреса вручную."); return; }
    let failed = 0;
    for (const h of holders) {
      const exists = await app.readProgram.account.voterSnapshot.fetchNullable(P!.snap(row.pda, h.owner));
      if (exists) continue;
      const r = await run(`Снимок для ${short(h.owner)} (${fmtRaw(h.amount, dec)})`, () => snapshot(h.owner, h.amount, h.account));
      if (!r.ok) failed++;
    }
    if (failed) alert(`Не внесено снимков: ${failed}. Чаще всего это держатель, который успел переместить монеты после скана (ошибка «вес больше баланса») — посмотрите журнал справа, прежде чем открывать голосование.`);
  };

  const openVoting = () =>
    run(`Начать голосование по предложению #${row.id}`, () =>
      program.methods
        .openVoting(new BN(row.id))
        .accounts({
          owner: active!.publicKey, config: P!.config, governanceMint: mint!, proposal: row.pda,
          quorumExcluded: data.pool ? data.config.quorumExcludedAccount : null,
        })
        .rpc(rpcOpts())
    );

  // clean-up: the rent of finished proposals / snapshots goes back to whoever paid it
  const closeSnapshots = async () => {
    const snaps = await app.readProgram.account.voterSnapshot.all([{ memcmp: { offset: 8, bytes: row.pda.toBase58() } }]);
    for (const sn of snaps) {
      await run(`Закрыть снимок ${short(sn.account.voter)} (вернуть аренду owner)`, () =>
        program.methods
          .closeVoterSnapshot(new BN(row.id), sn.account.voter)
          .accounts({ caller: active!.publicKey, config: P!.config, proposal: row.pda, voterSnapshot: sn.publicKey, ownerRefund: data.config.ownersAuthority })
          .rpc(rpcOpts())
      );
    }
  };
  const closeProposal = () =>
    run(`Закрыть предложение #${row.id} (вернуть аренду создателю)`, () =>
      program.methods
        .closeProposal(new BN(row.id))
        .accounts({ caller: active!.publicKey, config: P!.config, proposal: row.pda, creator: p.creator })
        .rpc(rpcOpts())
    );

  const vote = (support: boolean) => () =>
    run(`Голос «${support ? "за" : "против"}» по предложению #${row.id}`, () =>
      program.methods
        .vote(new BN(row.id), support)
        .accounts({ voter: active!.publicKey, config: P!.config, proposal: row.pda, voterSnapshot: P!.snap(row.pda, active!.publicKey) })
        .rpc(rpcOpts())
    );

  const execute = () =>
    run(`Исполнить предложение #${row.id}`, () =>
      program.methods
        .executeProposal(new BN(row.id))
        .accounts({
          executor: active!.publicKey, config: P!.config, treasuryMint: P!.treasuryMint,
          proposal: row.pda, treasury: P!.treasury,
          recipientTokenAccount: p.proposalType === 0 ? P!.tAta(p.target) : null,
          milestoneFund: p.proposalType === 6 ? P!.milestoneFund : null,
          tokenProgram: TPT,
        })
        .preInstructions(
          p.proposalType === 0
            ? [createAssociatedTokenAccountIdempotentInstruction(active!.publicKey, P!.tAta(p.target), p.target, P!.treasuryMint, TPT, ATAP)]
            : []
        )
        .rpc(rpcOpts())
    );

  const detail = () => {
    const t = p.proposalType;
    if (t === 0) return `${fmtRaw(p.amount, tdec)} ${data.treasurySymbol} → ${short(p.target)}`;
    if (t === 6) return `${fmtRaw(p.amount, tdec)} ${data.treasurySymbol} в фонд вех`;
    if (t === 4) return `${PARAM_KEYS[p.paramKey] ?? p.paramKey} = ${p.amount.toString()}`;
    return short(p.target);
  };

  return (
    <div className="prop">
      <div className="prop-h">
        <div>
          <b>#{row.id} · {PROPOSAL_TYPES[p.proposalType]}</b>
          <div className="muted">{detail()} · «{p.reason}»</div>
        </div>
        <Badge kind={s.kind}>{s.label}</Badge>
      </div>
      <div className="bar"><div className="for" style={{ width: `${total ? pctFor : 0}%` }} /><div className="against" style={{ width: `${total ? 100 - pctFor : 0}%` }} /></div>
      <div className="kvs">
        <Kv k="За" v={fmtRaw(s.vf, dec)} />
        <Kv k="Против" v={fmtRaw(s.va, dec)} />
        {s.open
          ? <Kv k="Кворум (база заморожена при старте)" v={<>{fmtRaw(total, dec)} из {fmtRaw(s.need, dec)} {s.quorum ? <Badge kind="ok">набран</Badge> : <Badge kind="warn">не набран</Badge>}</>} />
          : <Kv k="Внесено весов (сумма снимков)" v={fmtRaw(BigInt(p.totalSnapshotWeight.toString()), dec)} />}
        <Kv k="Голосование до" v={s.open ? tsFmt(s.dl) : <span className="muted">ещё не открыто</span>} />
        <Kv k="Можно исполнять с" v={s.open ? tsFmt(s.unlock) : "—"} />
        <Kv k="Президент может исполнять с" v={s.open ? tsFmt(s.fallbackAt) : "—"} />
        <Kv k="Исполнить можно до" v={s.open ? tsFmt(s.expiresAt) : "—"} />
        <Kv k="Создатель" v={<Copy text={p.creator.toBase58()}>{short(p.creator)}</Copy>} />
        <Kv k="Мой вес (снимок)" v={row.mySnap ? <>{fmtRaw(row.mySnap.weight, dec)} {row.mySnap.consumed && <Badge kind="ok">проголосовал</Badge>}</> : <span className="muted">снимка нет</span>} />
      </div>
      <div className="row acts">
        <Btn onClick={vote(true)} disabled={!active || !s.open} title={s.open ? "" : "Сначала owner должен начать голосование"}>Голосовать «за»</Btn>
        <Btn onClick={vote(false)} disabled={!active || !s.open} title={s.open ? "" : "Сначала owner должен начать голосование"}>Голосовать «против»</Btn>
        <Btn kind="primary" onClick={execute} disabled={!active} title="Может owner (или президент через запасной срок)">Исполнить</Btn>
        {(p.executed || (s.open && data.now > s.expiresAt)) && <Btn onClick={closeProposal} disabled={!active} title="Возвращает аренду аккаунта предложения его создателю">Закрыть предложение</Btn>}
      </div>
      <details>
        <summary>Снимки голосов и начало голосования (делает owner)</summary>
        <p className="muted">Порядок такой: 1) внести снимки всем держателям — «Внести всем» делает ОДИН скан и записывает ровно эти веса; 2) «Начать голосование» — с этого момента голосуют, снимки больше не принимаются, база кворума замораживается. Кто попытался перед этим переместить монеты, получит ошибку «вес больше баланса» — посмотрите журнал справа до старта.</p>
        <div className="row">
          <Field label="Адрес холдера" hint="Один адрес: вес = баланс прямо сейчас (для теста)">
            <TextIn mono value={who} onChange={setWho} placeholder={me} />
          </Field>
          <div className="row end">
            <Btn onClick={() => run(`Снимок для ${short(who || me)}`, () => snapshot(pk(who || me)))} disabled={!active || s.open}>Внести снимок</Btn>
            <Btn onClick={snapshotAll} disabled={!active || s.open}>Внести всем держателям (один скан)</Btn>
            <Btn kind="primary" onClick={openVoting} disabled={!active || s.open}>Начать голосование</Btn>
          </div>
        </div>
        {s.open && data.now > s.dl && <div className="row"><Btn onClick={closeSnapshots} disabled={!active} title="После окончания голосования снимки не нужны: закрытие возвращает аренду owner">Закрыть снимки этого предложения (вернуть аренду)</Btn></div>}
      </details>
    </div>
  );
}
