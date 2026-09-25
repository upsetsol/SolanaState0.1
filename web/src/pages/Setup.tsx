import React, { useEffect, useState } from "react";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ExtensionType, LENGTH_SIZE, TYPE_SIZE, createAssociatedTokenAccountIdempotentInstruction, createInitializeMintInstruction,
  createInitializeMetadataPointerInstruction, createMintToInstruction, createSyncNativeInstruction,
  createTransferCheckedInstruction, getMintLen, getAccount, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createInitializeInstruction as createInitMetadataIx, pack } from "@solana/spl-token-metadata";
import { useWallet } from "@solana/wallet-adapter-react";
import { useApp } from "../lib/ctx";
import { ATAP, BN, PARAM_FIELDS, PRESETS, TP, TPT, WSOL, fmtRaw, meteoraNftAccount, meteoraPosition, pk, short, toRaw } from "../lib/chain";
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
          <Field label="Монета государства (mint)" hint="Одна монета = одно государство. Создайте в шаге 3 или вставьте существующую.">
            <TextIn mono value={settings.mint} onChange={(v) => setSettings({ mint: v.trim() })} placeholder="адрес mint" />
          </Field>
          <Field label="Актив казны (mint)" hint="Парный актив пула. По умолчанию wSOL (обёрнутый SOL); для USDC/USDT вставьте их mint.">
            <TextIn mono value={settings.treasuryMint} onChange={(v) => setSettings({ treasuryMint: v.trim() })} />
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
        <Step5Pool />
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
    await run(`Отправить ${sendTok} токенов → ${short(target)}`, async () => {
      const raw = BigInt(amount.toString());
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(active.publicKey, P.ata(target), target, mint, TP, ATAP),
        createTransferCheckedInstruction(P.ata(active.publicKey), mint, P.ata(target), active.publicKey, raw, dec, [], TP)
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
  const { active, connection, settings, setSettings, data, run, provider, rpcOpts } = useApp();
  const [decimals, setDecimals] = useState("9");
  const [name, setName] = useState("Test 1");
  const [symbol, setSymbol] = useState("TEST1");
  const [supply, setSupply] = useState("1000000000");
  const done = !!data.mintInfo;
  const create = async () => {
    if (!active) throw new Error("Нет кошелька");
    const mintKp = Keypair.generate();
    const dec = Number(decimals);
    const meta = { mint: mintKp.publicKey, name, symbol, uri: "", additionalMetadata: [] as [string, string][] };
    const len = getMintLen([ExtensionType.MetadataPointer]);
    const rent = await connection.getMinimumBalanceForRentExemption(len + TYPE_SIZE + LENGTH_SIZE + pack(meta).length);
    const myAta = getAssociatedTokenAddressSync(mintKp.publicKey, active.publicKey, false, TP, ATAP);
    const raw = BigInt(Math.round(Number(supply))) * 10n ** BigInt(dec);
    const tx = new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: active.publicKey, newAccountPubkey: mintKp.publicKey, space: len, lamports: rent, programId: TP }),
      createInitializeMetadataPointerInstruction(mintKp.publicKey, active.publicKey, mintKp.publicKey, TP),
      createInitializeMintInstruction(mintKp.publicKey, dec, active.publicKey, null, TP),
      createInitMetadataIx({ programId: TP, metadata: mintKp.publicKey, updateAuthority: active.publicKey, mint: mintKp.publicKey, mintAuthority: active.publicKey, name, symbol, uri: "" }),
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
      <p className="muted">Монета государства: Token-2022 с названием и символом, <b>без налога</b>. Она даёт только голос. Казна наполняется комиссией пула (шаг 3.5) и лежит в другом активе (SOL/USDC). Весь выпуск зачисляется на активный кошелёк.</p>
      <div className="row">
        <Field label="Название"><TextIn value={name} onChange={setName} /></Field>
        <Field label="Символ"><TextIn value={symbol} onChange={setSymbol} /></Field>
        <Field label="Знаков после запятой"><TextIn value={decimals} onChange={setDecimals} /></Field>
        <Field label="Выпуск, токенов"><TextIn value={supply} onChange={setSupply} /></Field>
        <div className="row end"><Btn kind="primary" onClick={() => run("Создать токен", create)} disabled={!active}>Создать токен</Btn></div>
      </div>
      {data.mintInfo && (
        <div className="kvs">
          <Kv k="Токен" v={<Copy text={settings.mint}>{short(settings.mint)}</Copy>} />
          <Kv k="Выпуск" v={fmtRaw(data.mintInfo.supply, data.mintInfo.decimals)} />
          <Kv k="Налог на переводы" v="нет" />
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
        owner: active.publicKey, governanceMint: mint, treasuryMint: P.treasuryMint, config: P.config, treasury: P.treasury,
        tokenProgram: TPT, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.2. Инициализировать государство {done && <Badge kind="ok">готово</Badge>}</h4>
      <p className="muted">Создаёт запись Config и казну (счёт актива казны: {P?.treasuryMint.equals(WSOL) ? "wSOL" : short(P?.treasuryMint)}). Роли и параметры задаются здесь один раз; потом меняются только голосованием (порог гражданина и пауза: admin).</p>
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
  const { active, data, run, provider, rpcOpts, P } = useApp();
  const [amount, setAmount] = useState("0.5");
  const dec = data.treasuryDecimals;
  const fund = async () => {
    if (!active || !P) throw new Error("Нет данных");
    const raw = BigInt(toRaw(amount || "0", dec).toString());
    const tx = new Transaction();
    if (P.treasuryMint.equals(WSOL)) {
      // wrap SOL straight into the treasury account
      tx.add(
        SystemProgram.transfer({ fromPubkey: active.publicKey, toPubkey: P.treasury, lamports: Number(raw) }),
        createSyncNativeInstruction(P.treasury, TPT)
      );
    } else {
      tx.add(createTransferCheckedInstruction(P.tAta(active.publicKey), P.treasuryMint, P.treasury, active.publicKey, raw, dec, [], TPT));
    }
    return provider.sendAndConfirm(tx, [], rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.3. Положить актив в казну (для теста) {data.treasury && data.treasury > 0n ? <Badge kind="ok">готово</Badge> : null}</h4>
      <p className="muted">В работе казна наполняется комиссией пула (шаг 3.5), стартовой суммы не нужно. Для проверки голосований и зарплат можно положить SOL вручную: он заворачивается в wSOL прямо на счёт казны.</p>
      <div className="row">
        <Field label={`Сумма, ${data.treasurySymbol}`}><TextIn value={amount} onChange={setAmount} /></Field>
        <div className="row end"><Btn kind="primary" onClick={() => run("Пополнить казну", fund)} disabled={!data.config}>Перевести в казну</Btn></div>
        <Kv k="В казне сейчас" v={data.treasury === null ? "—" : `${fmtRaw(data.treasury, dec)} ${data.treasurySymbol}`} />
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
      .accounts({ owner: active.publicKey, config: P.config, treasuryMint: P.treasuryMint, milestoneFund: P.milestoneFund, tokenProgram: TPT, systemProgram: SystemProgram.programId })
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

function Step5Pool() {
  const { active, data, run, program, rpcOpts, P, mint, settings } = useApp();
  const [pool, setPool] = useState("");
  const [nft, setNft] = useState("");
  const done = !!data.pool;
  const reg = async () => {
    if (!active || !P || !mint) throw new Error("Нет данных");
    const nftMint = pk(nft, "mint NFT позиции");
    return program.methods
      .registerPool()
      .accounts({
        owner: active.publicKey, config: P.config, governanceMint: mint, pool: pk(pool, "адрес пула"),
        position: meteoraPosition(nftMint), positionNftAccount: meteoraNftAccount(nftMint), feeAAccount: P.feeA,
        governanceTokenProgram: TP, associatedTokenProgram: ATAP, systemProgram: SystemProgram.programId,
      })
      .rpc(rpcOpts());
  };
  return (
    <div className="step">
      <h4>Шаг 3.5. Пул Meteora: источник казны {done && <Badge kind="ok">привязан</Badge>}</h4>
      <p className="muted">
        Пул (монета государства / актив казны) с постоянной комиссией 5% в активе казны создаётся в консоли скриптом <span className="mono">scripts/create_pool.ts</span>:
        он же блокирует ликвидность навсегда и передаёт позицию государству. Здесь пул привязывается (один раз, только owner): контракт сам проверяет пару токенов,
        режим комиссии и владельца позиции.
      </p>
      {!done && (
        <div className="row">
          <Field label="Адрес пула"><TextIn mono value={pool} onChange={setPool} placeholder="из вывода create_pool.ts" /></Field>
          <Field label="Mint NFT позиции"><TextIn mono value={nft} onChange={setNft} placeholder="positionNft из вывода" /></Field>
          <div className="row end"><Btn kind="primary" onClick={() => run("Привязать пул", reg)} disabled={!data.config || !active}>Привязать пул</Btn></div>
        </div>
      )}
      {data.pool && (
        <div className="kvs">
          <Kv k="Пул" v={<Copy text={data.pool.pool.toBase58()}>{short(data.pool.pool)}</Copy>} />
          <Kv k="Позиция" v={<Copy text={data.pool.position.toBase58()}>{short(data.pool.position)}</Copy>} />
          <Kv k="Забрать комиссию" v="вкладка «Деньги»" />
        </div>
      )}
    </div>
  );
}
