import React, { useState } from "react";
import { useApp } from "./lib/ctx";
import { explorerTx, short } from "./lib/chain";
import Setup from "./pages/Setup";
import Overview from "./pages/Overview";
import Proposals from "./pages/Proposals";
import Money from "./pages/Money";
import Milestones from "./pages/Milestones";
import Admin from "./pages/Admin";

const TABS: [string, string, React.ComponentType][] = [
  ["setup", "Настройка", Setup],
  ["overview", "Обзор", Overview],
  ["proposals", "Предложения", Proposals],
  ["money", "Деньги", Money],
  ["milestones", "Вехи", Milestones],
  ["admin", "Админ", Admin],
];

export default function App() {
  const { active, signers, setActiveId, data, settings, log, clearLog, refresh } = useApp();
  const [tab, setTab] = useState(() => localStorage.getItem("tab") || "setup");
  const go = (t: string) => { setTab(t); try { localStorage.setItem("tab", t); } catch { /* */ } };
  const Page = (TABS.find((t) => t[0] === tab) ?? TABS[0])[2];

  return (
    <div className="app">
      <header>
        <div>
          <b>On-Chain State</b> <span className="muted">тестовая панель контракта</span>
        </div>
        <div className="hdr-r">
          <span className="muted">{settings.rpc.replace(/^https?:\/\//, "").replace(/\?.*$/, "")}</span>
          <select value={active?.id ?? ""} onChange={(e) => setActiveId(e.target.value)} title="От чьего имени выполняются действия">
            {signers.length === 0 && <option value="">нет кошелька</option>}
            {signers.map((s) => <option key={s.id} value={s.id}>{s.label} · {short(s.publicKey)}</option>)}
          </select>
          <button onClick={refresh} title="Обновить данные">↻</button>
        </div>
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? "on" : ""} onClick={() => go(id)}>{label}</button>
        ))}
      </nav>
      <main>
        {!data.loaded && <p className="muted">Загрузка данных из сети…</p>}
        <Page />
      </main>
      <footer>
        <div className="log-h">
          <b>Журнал действий</b>
          <button onClick={clearLog}>Очистить</button>
        </div>
        <div className="log">
          {log.length === 0 && <span className="muted">Здесь появятся все транзакции и ответы контракта, включая отказы с названием ошибки.</span>}
          {log.map((e) => (
            <div key={e.n} className={`log-r ${e.status}`}>
              <span className="muted">{new Date(e.time).toLocaleTimeString("ru-RU")}</span>
              <span className="who">{e.who}</span>
              <span className="what">{e.label}</span>
              <span className="res">
                {e.status === "pending" && "отправляется…"}
                {e.status === "ok" && (e.sig ? <a href={explorerTx(settings.rpc, e.sig)} target="_blank" rel="noreferrer">✓ {e.sig.slice(0, 10)}…</a> : "✓")}
                {e.status === "err" && <span title={e.err}>✗ {e.err}</span>}
              </span>
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}
