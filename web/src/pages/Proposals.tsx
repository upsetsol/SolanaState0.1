import React, { useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { useApp, ProposalRow } from "../lib/ctx";
import { BN, PARAM_KEYS, PROPOSAL_TYPES, TP, fmtDur, fmtRaw, pk, short, toRaw, tsFmt } from "../lib/chain";
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
  const dec = data.mintInfo?.decimals ?? 9;
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
    const amt = type === 4 ? new BN(amount || "0") : usesAmountTokens ? toRaw(amount || "0", dec) : new BN(0);
    const tgt = usesTarget ? pk(target || me) : active.publicKey;
    return program.methods
      .createProposal(type, tgt, amt, type === 4 ? paramKey : 0, reason || PROPOSAL_TYPES[type])
      .accounts({
        creator: active.publicKey, governanceMint: mint, creatorTokenAccount: P.ata(active.publicKey),
        config: P.config, treasury: P.treasury, proposal: P.proposal(id), tokenProgram: TP, systemProgram: SystemProgram.programId,
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
          <Field label={type === 4 ? "Новое значение (число)" : "Сумма, токенов"}>
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
  const dl = Number(p.deadline.toString());
  const tl = Number(c.timelockSecs.toString());
  const fb = Number(c.execFallbackSecs.toString());
  const unlock = dl + tl;
  const supply: bigint = data.mintInfo.supply;
  const treasury: bigint = data.treasury ?? 0n;
  const circ = supply > treasury ? supply - treasury : 0n;
  const qbps = BigInt((p.proposalType === 0 || p.proposalType === 6 ? c.quorumSpendBps : p.proposalType <= 3 ? c.quorumRoleBps : c.quorumParamBps).toString());
  const vf = BigInt(p.votesFor.toString());
  const va = BigInt(p.votesAgainst.toString());
  const quorum = (vf + va) * 10000n >= circ * qbps;
  const passed = vf > va;
  let label: string; let kind: "ok" | "warn" | "err" | "info";
  if (p.executed) { label = "Исполнено"; kind = "ok"; }
  else if (now <= dl) { label = `Идёт голосование, осталось ${fmtDur(dl - now)}`; kind = "info"; }
  else if (!quorum) { label = "Не набран кворум"; kind = "err"; }
  else if (!passed) { label = "Отклонено"; kind = "err"; }
  else if (now < unlock) { label = `Принято, ждёт исполнения ${fmtDur(unlock - now)}`; kind = "warn"; }
  else { label = "Готово к исполнению"; kind = "ok"; }
  return { label, kind, dl, unlock, fallbackAt: unlock + fb, quorum, passed, vf, va, circ, qbps, need: (circ * qbps) / 10000n };
}

function Proposal({ row }: { row: ProposalRow }) {
  const app = useApp();
  const { data, active, run, program, rpcOpts, P, mint, scanHolders } = app;
  const dec = data.mintInfo!.decimals;
  const p = row.data;
  const s = stageOf(row, data);
  const [who, setWho] = useState("");
  const me = active?.publicKey.toBase58() ?? "";
  const total = s.vf + s.va;
  const pctFor = total ? Number((s.vf * 1000n) / total) / 10 : 0;

  const snapshot = async (voter: PublicKey) =>
    program.methods
      .postVoterSnapshot(new BN(row.id), voter)
      .accounts({
        owner: active!.publicKey, config: P!.config, proposal: row.pda, voterTokenAccount: P!.ata(voter),
        voterSnapshot: P!.snap(row.pda, voter), systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());

  const snapshotAll = async () => {
    const holders = await scanHolders();
    if (!holders.length) { alert("Держателей токена не найдено (или RPC не разрешил поиск). Внесите адреса вручную."); return; }
    for (const h of holders) {
      const exists = await app.readProgram.account.voterSnapshot.fetchNullable(P!.snap(row.pda, h.owner));
      if (exists) continue;
      const r = await run(`Снимок для ${short(h.owner)} (${fmtRaw(h.amount, dec)})`, () => snapshot(h.owner));
      if (!r.ok) break;
    }
  };

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
          executor: active!.publicKey, governanceMint: mint!, config: P!.config, proposal: row.pda, treasury: P!.treasury,
          recipientTokenAccount: p.proposalType === 0 ? P!.ata(p.target) : null,
          milestoneFund: p.proposalType === 6 ? P!.milestoneFund : null,
          tokenProgram: TP,
        })
        .rpc(rpcOpts())
    );

  const detail = () => {
    const t = p.proposalType;
    if (t === 0) return `${fmtRaw(p.amount, dec)} токенов → ${short(p.target)}`;
    if (t === 6) return `${fmtRaw(p.amount, dec)} токенов в фонд вех`;
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
        <Kv k="Кворум" v={<>{fmtRaw(total, dec)} из {fmtRaw(s.need, dec)} {s.quorum ? <Badge kind="ok">набран</Badge> : <Badge kind="warn">не набран</Badge>}</>} />
        <Kv k="Голосование до" v={tsFmt(s.dl)} />
        <Kv k="Можно исполнять с" v={tsFmt(s.unlock)} />
        <Kv k="Президент может исполнять с" v={tsFmt(s.fallbackAt)} />
        <Kv k="Создатель" v={<Copy text={p.creator.toBase58()}>{short(p.creator)}</Copy>} />
        <Kv k="Мой вес (снимок)" v={row.mySnap ? <>{fmtRaw(row.mySnap.weight, dec)} {row.mySnap.consumed && <Badge kind="ok">проголосовал</Badge>}</> : <span className="muted">снимка нет</span>} />
      </div>
      <div className="row acts">
        <Btn onClick={vote(true)} disabled={!active}>Голосовать «за»</Btn>
        <Btn onClick={vote(false)} disabled={!active}>Голосовать «против»</Btn>
        <Btn kind="primary" onClick={execute} disabled={!active} title="Может owner (или президент через запасной срок)">Исполнить</Btn>
      </div>
      <details>
        <summary>Снимки голосов (делает owner, до первого голоса)</summary>
        <div className="row">
          <Field label="Адрес холдера" hint="Вес считается контрактом по реальному балансу токен-счёта">
            <TextIn mono value={who} onChange={setWho} placeholder={me} />
          </Field>
          <div className="row end">
            <Btn onClick={() => run(`Снимок для ${short(who || me)}`, () => snapshot(pk(who || me)))} disabled={!active}>Внести снимок</Btn>
            <Btn onClick={snapshotAll} disabled={!active}>Внести всем держателям</Btn>
          </div>
        </div>
      </details>
    </div>
  );
}
