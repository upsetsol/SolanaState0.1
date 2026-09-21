import React, { useEffect, useState } from "react";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ExtensionType, createAssociatedTokenAccountIdempotentInstruction, createInitializeMintInstruction,
  createInitializeTransferFeeConfigInstruction, createMintToInstruction,
  createTransferCheckedWithFeeInstruction, getMintLen, getAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useApp } from "../lib/ctx";
import { ATAP, BN, PARAM_FIELDS, PRESETS, TP, fmtRaw, pk, short, toRaw } from "../lib/chain";
import { Badge, Btn, Card, Copy, Field, Kv, Note, TextIn } from "../lib/ui";

const NETS = [
  ["Testnet (публичный)", "https://api.testnet.solana.com"],
  ["Devnet (публичный)", "https://api.devnet.solana.com"],
  ["Локальный валидатор", "http://127.0.0.1:8899"],
];

export default function Setup() {
  const app = useApp();
  const { settings, setSettings, data, active, signers, connection, P, mint, run, program, provider, rpcOpts } = app;
  const wallet = useWallet();
  const dec = data.mintInfo?.decimals ?? 9;

  return (
    <>
      <Card title="1. Сеть и программа">
        <div className="grid2">
          <Field label="Сеть (RPC)">
            <select
              value={NETS.some((n) => n[1] === settings.rpc) ? settings.rpc : "custom"}
              onChange={(e) => e.target.value !== "custom" && setSettings({ rpc: e.target.value })}
            >
              {NETS.map(([l, u]) => <option key={u} value={u}>{l}</option>)}
              <option value="custom">Свой URL…</option>
            </select>
          </Field>
          <Field label="RPC URL"><TextIn mono value={settings.rpc} onChange={(v) => setSettings({ rpc: v })} /></Field>
          <Field label="Program ID" hint="Из файла idl/. Менять только если развернули свою копию.">
            <TextIn mono value={settings.programId} onChange={(v) => setSettings({ programId: v })} />
          </Field>
          <Field label="Токен государства (mint)" hint="Один токен = одно государство. Создайте в шаге 3 или вставьте существующий.">
            <TextIn mono value={settings.mint} onChange={(v) => setSettings({ mint: v.trim() })} placeholder="адрес mint" />
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.skipPreflight} onChange={(e) => setSettings({ skipPreflight: e.target.checked })} />
          Отправлять без предварительной проверки: для тестов, когда нужно, чтобы контракт сам отклонил действие
          (иначе кошелёк/RPC отсекает заведомо неудачные транзакции до отправки)
        </label>
        {app.mainnet && <Note kind="err">Выбран mainnet: встроенные тестовые кошельки отключены. Этот интерфейс предназначен для тестовых сетей.</Note>}
        {data.error && <Note kind="err">Ошибка чтения сети: {data.error}</Note>}
      </Card>

      <Wallets />

      <Card title="3. Запуск государства (мастер)">
        {!active && <Note kind="warn">Сначала выберите кошелёк (шаг 2): он будет оплачивать транзакции и станет эмитентом токена.</Note>}
        <Step1Mint />
        <Step2Init />
        <Step3Fund />
        <Step4MilestoneFund />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- wallets

function Wallets() {
  const app = useApp();
  const { signers, active, setActiveId, burners, addBurner, removeBurner, connection, settings, data, P, mint, run, mainnet } = app;
  const wallet = useWallet();
  const [bal, setBal] = useState<Record<string, { sol: number; tok: bigint | null }>>({});
  const [importText, setImportText] = useState("");
  const [sendSol, setSendSol] = useState("0.05");
  const [sendTok, setSendTok] = useState("1000000");
  const [to, setTo] = useState("");
  const dec = data.mintInfo?.decimals ?? 9;

  useEffect(() => {
    let dead = false;
    const go = async () => {
      const out: Record<string, { sol: number; tok: bigint | null }> = {};
      for (const s of signers) {
        let sol = 0;
        let tok: bigint | null = null;
        try { sol = (await connection.getBalance(s.publicKey)) / LAMPORTS_PER_SOL; } catch { /* */ }
        if (P) { try { tok = (await getAccount(connection, P.ata(s.publicKey), "confirmed", TP)).amount; } catch { tok = null; } }
        out[s.id] = { sol, tok };
      }
      if (!dead) setBal(out);
    };
    go();
    const t = setInterval(go, 10000);
    return () => { dead = true; clearInterval(t); };
  }, [signers.map((s) => s.id).join(","), connection, P, data.now]);

  const cfg = data.config;
  const roles = (pkb: PublicKey) => {
    if (!cfg) return [] as string[];
    const r: string[] = [];
    if (cfg.ownersAuthority.equals(pkb)) r.push("owner");
    if (cfg.adminAuthority.equals(pkb)) r.push("admin");
    if (cfg.president.equals(pkb)) r.push("президент");
    if (cfg.financeMinister.equals(pkb)) r.push("минфин");
    if (cfg.cultureMinister.equals(pkb)) r.push("минкульт");
    return r;
  };

  const airdrop = async (target: PublicKey) => {
    await run("Airdrop 2 SOL", async () => {
      const sig = await connection.requestAirdrop(target, 2 * LAMPORTS_PER_SOL);
      const bh = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
      return sig;
    });
  };

  const sendSolTo = async (target: PublicKey) => {
    if (!active) return;
    await run(`Отправить ${sendSol} SOL → ${short(target)}`, async () => {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: active.publicKey, toPubkey: target, lamports: Math.round(Number(sendSol) * LAMPORTS_PER_SOL) }));
      return app.provider.sendAndConfirm(tx, [], app.rpcOpts());
    });
  };

  const sendTokensTo = async (target: PublicKey) => {
    if (!active || !mint || !P || !data.mintInfo) return;
    const amount = toRaw(sendTok, dec);
    await run(`Отправить ${sendTok} токенов → ${short(target)} (с налогом)`, async () => {
      const bps = BigInt(data.mintInfo!.feeBps ?? 0);
      const raw = BigInt(amount.toString());
      const fee = (raw * bps + 9999n) / 10000n;
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(active.publicKey, P.ata(target), target, mint, TP, ATAP),
        createTransferCheckedWithFeeInstruction(P.ata(active.publicKey), mint, P.ata(target), active.publicKey, raw, dec, fee, [], TP)
      );
      return app.provider.sendAndConfirm(tx, [], app.rpcOpts());
    });
  };

  return (
    <Card
      title="2. Кошельки"
      right={
        <>
          <button onClick={() => addBurner()} disabled={mainnet}>+ Тестовый кошелёк</button>{" "}
          <ConnectPhantom />
        </>
      }
    >
      <Note>
        Тестовые кошельки хранятся в браузере (localStorage) и подписывают транзакции без запросов подтверждения. Только для тестовых сетей,
        никогда не кладите на них настоящие деньги. Переключаясь между ними, вы действуете от разных ролей (owner, президент, холдер).
      </Note>
      {signers.length === 0 && <p className="muted">Кошельков нет. Создайте тестовый или подключите Phantom.</p>}
      <table className="tbl">
        <thead><tr><th></th><th>Название</th><th>Адрес</th><th>SOL</th><th>Токены</th><th>Роли</th><th></th></tr></thead>
        <tbody>
          {signers.map((s) => {
            const b = bal[s.id];
            return (
              <tr key={s.id} className={active?.id === s.id ? "sel" : ""}>
                <td><input type="radio" name="active" checked={active?.id === s.id} onChange={() => setActiveId(s.id)} /></td>
                <td>{s.label} {s.kind === "phantom" && <Badge kind="info">внешний</Badge>}</td>
                <td><Copy text={s.publicKey.toBase58()}>{short(s.publicKey)}</Copy></td>
                <td>{b ? b.sol.toFixed(3) : "…"}</td>
                <td>{b?.tok !== null && b?.tok !== undefined ? fmtRaw(b.tok, dec) : "—"}</td>
                <td>{roles(s.publicKey).map((r) => <Badge key={r} kind="ok">{r}</Badge>)}</td>
                <td className="acts">
                  <Btn onClick={() => airdrop(s.publicKey)} title="Работает на локальном валидаторе и devnet">Airdrop</Btn>
                  {s.kind === "burner" && (
                    <>
                      <button onClick={() => { const bb = burners.find((x) => x.id === s.id); if (bb) navigator.clipboard?.writeText(JSON.stringify(bb.secret)); }} title="Копирует секретный ключ (только для тестов)">Ключ</button>
                      <button onClick={() => removeBurner(s.id)}>Удалить</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {burners.length > 0 || signers.length > 0 ? (
        <div className="row">
          <Field label="Кому (адрес)">
            <div className="row">
              <select onChange={(e) => setTo(e.target.value)} value="">
                <option value="">выбрать из списка…</option>
                {signers.map((s) => <option key={s.id} value={s.publicKey.toBase58()}>{s.label} ({short(s.publicKey)})</option>)}
              </select>
              <TextIn mono value={to} onChange={setTo} placeholder="адрес получателя" />
            </div>
          </Field>
          <Field label="SOL"><TextIn value={sendSol} onChange={setSendSol} /></Field>
          <Field label="Токенов"><TextIn value={sendTok} onChange={setSendTok} /></Field>
          <div className="row end">
            <Btn onClick={() => sendSolTo(pk(to))} disabled={!active || !to}>Отправить SOL</Btn>
            <Btn onClick={() => sendTokensTo(pk(to))} disabled={!active || !to || !data.mintInfo}>Отправить токены</Btn>
          </div>
        </div>
      ) : null}
      <details>
        <summary>Импорт тестового кошелька</summary>
        <div className="row">
          <TextIn mono value={importText} onChange={setImportText} placeholder="секретный ключ: массив [12,34,…]" />
          <button onClick={() => { try { addBurner("Импортированный", JSON.parse(importText)); setImportText(""); } catch { alert("Неверный формат ключа"); } }}>Импортировать</button>
        </div>
      </details>
    </Card>
  );
}

function ConnectPhantom() {
  const { wallets, select, connect, disconnect, connected, wallet } = useWallet();
  const installed = wallets.filter((w) => w.readyState === "Installed");
  if (connected) return <button onClick={() => disconnect()}>Отключить {wallet?.adapter.name}</button>;
  if (installed.length === 0) return <span className="muted">Phantom не найден в браузере</span>;
  return (
    <>
      {installed.map((w) => (
        <button key={w.adapter.name} onClick={async () => { select(w.adapter.name); setTimeout(() => connect().catch(() => {}), 50); }}>
          Подключить {w.adapter.name}
        </button>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- wizard

function Step1Mint() {
  const { active, connection, settings, setSettings, data, run, provider, rpcOpts, programId } = useApp();
  const [decimals, setDecimals] = useState("9");
  const [feeBps, setFeeBps] = useState("500");
  const [supply, setSupply] = useState("1000000000");
  const done = !!data.mintInfo;
  const create = async () => {
    if (!active) throw new Error("Нет кошелька");
    const mintKp = Keypair.generate();
    const [config] = PublicKey.findProgramAddressSync([Buffer.from("config"), mintKp.publicKey.toBuffer()], programId);
    const dec = Number(decimals);
    const len = getMintLen([ExtensionType.TransferFeeConfig]);
    const rent = await connection.getMinimumBalanceForRentExemption(len);
    const myAta = getAssociatedTokenAddressSync(mintKp.publicKey, active.publicKey, false, TP, ATAP);
    const raw = BigInt(Math.round(Number(supply))) * 10n ** BigInt(dec);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: active.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports: rent, programId: TP }),
      createInitializeTransferFeeConfigInstruction(mintKp.publicKey, null, config, Number(feeBps), BigInt("18446744073709551615"), TP),
      createInitializeMintInstruction(mintKp.publicKey, dec, active.publicKey, null, TP),
      createAssociatedTokenAccountIdempotentInstruction(active.publicKey, myAta, active.publicKey, mintKp.publicKey, TP, ATAP),
      createMintToInstruction(mintKp.publicKey, myAta, active.publicKey, raw, [], TP)
    );
    const sig = await provider.sendAndConfirm(tx, [mintKp], rpcOpts());
    setSettings({ mint: mintKp.publicKey.toBase58() });
    return sig;
  };
  return (
    <div className="step">
      <h4>Шаг 3.1. Создать токен {done && <Badge kind="ok">готово</Badge>}</h4>
      <p className="muted">Token-2022 с налогом на переводы. Право менять налог не выдаётся никому (заморожен навсегда). Право сбора налога получает программа. Весь выпуск зачисляется на активный кошелёк.</p>
      <div className="row">
        <Field label="Знаков после запятой"><TextIn value={decimals} onChange={setDecimals} /></Field>
        <Field label="Налог, bps (500 = 5%)"><TextIn value={feeBps} onChange={setFeeBps} /></Field>
        <Field label="Выпуск, токенов"><TextIn value={supply} onChange={setSupply} /></Field>
        <div className="row end"><Btn kind="primary" onClick={() => run("Создать токен", create)} disabled={!active}>Создать токен</Btn></div>
      </div>
      {data.mintInfo && (
        <div className="kvs">
          <Kv k="Токен" v={<Copy text={settings.mint}>{short(settings.mint)}</Copy>} />
          <Kv k="Выпуск" v={fmtRaw(data.mintInfo.supply, data.mintInfo.decimals)} />
          <Kv k="Налог" v={data.mintInfo.feeBps === null ? "нет" : `${data.mintInfo.feeBps / 100}%`} />
          <Kv k="Кто может менять налог" v={data.mintInfo.feeAuthority ? short(data.mintInfo.feeAuthority) : "никто (заморожен)"} />
          <Kv k="Право забирать налог" v={short(data.mintInfo.withheldAuthority)} />
          <Kv k="Право выпускать монеты" v={data.mintInfo.mintAuthority ? short(data.mintInfo.mintAuthority) : "нет"} />
        </div>
      )}
    </div>
  );
}

function Step2Init() {
  const { active, data, run, program, rpcOpts, P, mint } = useApp();
  const [preset, setPreset] = useState("fast");
  const [p, setP] = useState<Record<string, number>>({ ...PRESETS.fast.p });
  const [owners, setOwners] = useState("");
  const [admin, setAdmin] = useState("");
  const [pres, setPres] = useState("");
  const done = !!data.config;
  const me = active?.publicKey.toBase58() ?? "";
  const init = async () => {
    if (!mint || !P || !active) throw new Error("Нужен токен и кошелёк");
    const n = (k: string) => new BN(String(p[k]));
    return program.methods
      .initialize(
        pk(owners || me), pk(admin || me), pk(pres || me),
        n("votingPeriodSecs"), n("proposalThresholdBps"), n("quorumSpendBps"), n("quorumRoleBps"), n("quorumParamBps"),
        n("financeDailyBps"), n("financeWeeklyBps"), n("cultureDailyBps"), n("cultureWeeklyBps"), n("timelockSecs"),
        n("payrollPresidentBps"), n("payrollFinanceBps"), n("payrollCultureBps"), n("citizenshipThresholdBps"),
        n("milestoneDepositBps"), n("spendCooldownSecs"), n("execFallbackSecs"), n("milestoneGraceSecs")
      )
      .accounts({
        owner: active.publicKey, governanceMint: mint, config: P.config, treasury: P.treasury,
        tokenProgram: TP, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.2. Инициализировать государство {done && <Badge kind="ok">готово</Badge>}</h4>
      <p className="muted">Создаёт запись Config и казну. Роли и параметры задаются здесь один раз; потом меняются только голосованием (порог гражданина и пауза: admin).</p>
      <div className="row">
        <Field label="Набор параметров">
          <select value={preset} onChange={(e) => { setPreset(e.target.value); setP({ ...PRESETS[e.target.value].p }); }}>
            {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="owners_authority" hint="Пусто = активный кошелёк"><TextIn mono value={owners} onChange={setOwners} placeholder={me} /></Field>
        <Field label="admin_authority" hint="Пусто = активный кошелёк"><TextIn mono value={admin} onChange={setAdmin} placeholder={me} /></Field>
        <Field label="Первый президент" hint="Пусто = активный кошелёк"><TextIn mono value={pres} onChange={setPres} placeholder={me} /></Field>
      </div>
      <details>
        <summary>Параметры ({PARAM_FIELDS.length})</summary>
        <div className="grid3">
          {PARAM_FIELDS.map(([k, l]) => (
            <Field key={k} label={l}><TextIn value={String(p[k])} onChange={(v) => setP({ ...p, [k]: Number(v) || 0 })} /></Field>
          ))}
        </div>
      </details>
      <div className="row end">
        <Btn kind="primary" onClick={() => run("Инициализировать государство", init)} disabled={!active || !data.mintInfo}>Инициализировать</Btn>
      </div>
    </div>
  );
}

function Step3Fund() {
  const { active, data, run, provider, rpcOpts, P, mint } = useApp();
  const [bps, setBps] = useState("500");
  const dec = data.mintInfo?.decimals ?? 9;
  const fund = async () => {
    if (!active || !mint || !P || !data.mintInfo) throw new Error("Нет данных");
    const raw = (data.mintInfo.supply * BigInt(bps)) / 10000n;
    const fee = (raw * BigInt(data.mintInfo.feeBps ?? 0) + 9999n) / 10000n;
    const tx = new Transaction().add(
      createTransferCheckedWithFeeInstruction(P.ata(active.publicKey), mint, P.treasury, active.publicKey, raw, dec, fee, [], TP)
    );
    return provider.sendAndConfirm(tx, [], rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.3. Стартовая казна {data.treasury && data.treasury > 0n ? <Badge kind="ok">готово</Badge> : null}</h4>
      <p className="muted">Переводит долю от общего выпуска с активного кошелька (он должен держать токены) в казну. По решению owner'а: 5%. Налог удерживается.</p>
      <div className="row">
        <Field label="Доля выпуска, bps (500 = 5%)"><TextIn value={bps} onChange={setBps} /></Field>
        <div className="row end"><Btn kind="primary" onClick={() => run("Пополнить казну", fund)} disabled={!data.config}>Перевести в казну</Btn></div>
        <Kv k="В казне сейчас" v={data.treasury === null ? "—" : fmtRaw(data.treasury, dec)} />
      </div>
    </div>
  );
}

function Step4MilestoneFund() {
  const { active, data, run, program, rpcOpts, P, mint } = useApp();
  const done = data.config && !data.config.milestoneFundTokenAccount.equals(PublicKey.default);
  const go = async () => {
    if (!active || !mint || !P) throw new Error("Нет данных");
    return program.methods
      .setupMilestoneFund()
      .accounts({ owner: active.publicKey, governanceMint: mint, config: P.config, milestoneFund: P.milestoneFund, tokenProgram: TP, systemProgram: SystemProgram.programId })
      .rpc(rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.4. Создать фонд вех {done && <Badge kind="ok">готово</Badge>}</h4>
      <p className="muted">Отдельный счёт наград для «граждан». Пополняется только через голосование (тип «Пополнить фонд вех»). Делает owner.</p>
      <Btn kind="primary" onClick={() => run("Создать фонд вех", go)} disabled={!data.config}>Создать фонд вех</Btn>
    </div>
  );
}
