import React, { useState } from "react";
import { useApp } from "../lib/ctx";
import { BN, short } from "../lib/chain";
import { Badge, Btn, Card, Field, Kv, Note, TextIn } from "../lib/ui";

export default function Admin() {
  const { data, active, run, program, rpcOpts, P, mint } = useApp();
  const [bps, setBps] = useState("25");
  const c = data.config;
  if (!mint || !c) return <Note kind="warn">Сначала запустите государство (вкладка «Настройка»).</Note>;
  const isAdmin = active && c.adminAuthority.equals(active.publicKey);

  const setPause = (paused: boolean) => () =>
    run(paused ? "Включить паузу" : "Снять паузу", () =>
      program.methods.setPause(paused).accounts({ admin: active!.publicKey, config: P!.config }).rpc(rpcOpts())
    );
  const setThr = () =>
    run(`Порог гражданина → ${bps} bps`, () =>
      program.methods.setCitizenshipThreshold(new BN(bps)).accounts({ admin: active!.publicKey, config: P!.config }).rpc(rpcOpts())
    );

  return (
    <>
      <Card title="Аварийная пауза">
        <p className="muted">
          Пауза останавливает все выплаты из казны и фонда: зарплаты, траты министров, исполнение предложений, выплаты по вехам. Сбор налога в казну не останавливается (это приток). Включает и снимает только admin.
        </p>
        <Kv k="Сейчас" v={c.paused ? <Badge kind="err">ПАУЗА ВКЛЮЧЕНА</Badge> : <Badge kind="ok">работает</Badge>} />
        <Kv k="admin_authority" v={short(c.adminAuthority)} />
        <Kv k="Активный кошелёк это admin?" v={isAdmin ? <Badge kind="ok">да</Badge> : <Badge kind="warn">нет: контракт откажет</Badge>} />
        <div className="row">
          <Btn kind="danger" onClick={setPause(true)} disabled={!active}>Включить паузу</Btn>
          <Btn onClick={setPause(false)} disabled={!active}>Снять паузу</Btn>
        </div>
      </Card>
      <Card title="Порог «гражданина»">
        <p className="muted">Минимальная доля выпуска для участия в вехах. Меняет только admin, без голосования (по решению owner'а). Сейчас: {Number(c.citizenshipThresholdBps.toString())} bps = {Number(c.citizenshipThresholdBps.toString()) / 100}%.</p>
        <div className="row">
          <Field label="Новое значение, bps (25 = 0.25%)"><TextIn value={bps} onChange={setBps} /></Field>
          <div className="row end"><Btn onClick={setThr} disabled={!active}>Установить</Btn></div>
        </div>
      </Card>
    </>
  );
}
