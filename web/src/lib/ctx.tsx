import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getMint, getAccount, unpackAccount } from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  AppSigner, DEFAULT_PROGRAM_ID, METEORA_POOL_AUTHORITY, Pdas, TP, TPT, WSOL, burnerSigner, describeError,
  makeProgram, makeProvider, pdas, readPendingPoolFee,
} from "./chain";

export interface Settings {
  rpc: string;
  programId: string;
  /** the state's voting coin */
  mint: string;
  /** asset of the treasury (the pool's quote asset); wSOL unless changed */
  treasuryMint: string;
  skipPreflight: boolean;
}
const DEFAULT_SETTINGS: Settings = {
  rpc: "https://api.testnet.solana.com",
  programId: DEFAULT_PROGRAM_ID.toBase58(),
  mint: "",
  treasuryMint: WSOL.toBase58(),
  skipPreflight: false,
};

export interface Burner { id: string; label: string; secret: number[] }
export interface LogEntry {
  n: number; time: number; label: string; who: string;
  status: "pending" | "ok" | "err"; sig?: string; err?: string;
}

export interface MintInfo {
  decimals: number; supply: bigint; mintAuthority: string | null;
}
/** The Meteora pool linked to the state (null until register_pool). */
export interface PoolInfo {
  pool: PublicKey; position: PublicKey;
  /** governance coins sitting in the pool vault (they cannot vote: excluded from the voting base) */
  vault: bigint | null;
  /** trading fee accrued on the position, waiting for claim_pool_fees (raw units of the treasury asset) */
  pending: bigint | null;
}
export interface ProposalRow { id: number; pda: PublicKey; data: any; mySnap: any | null }
export interface ChainData {
  loaded: boolean; error: string | null;
  config: any | null; mintInfo: MintInfo | null;
  treasury: bigint | null; fund: bigint | null;
  /** decimals and short name of the treasury asset (wSOL = "SOL") */
  treasuryDecimals: number; treasurySymbol: string;
  pool: PoolInfo | null;
  proposals: ProposalRow[]; now: number;
  myTokens: bigint | null; mySol: number | null;
}
const EMPTY: ChainData = {
  loaded: false, error: null, config: null, mintInfo: null, treasury: null, fund: null,
  treasuryDecimals: 9, treasurySymbol: "SOL", pool: null,
  proposals: [], now: Math.floor(Date.now() / 1000), myTokens: null, mySol: null,
};

export const MIN_SOL_LAMPORTS = 10_000_000; // 0.01 SOL: covers the most expensive step (token + accounts)

export interface Holder { owner: PublicKey; account: PublicKey; amount: bigint }

interface Ctx {
  settings: Settings; setSettings: (s: Partial<Settings>) => void;
  connection: Connection; programId: PublicKey; mint: PublicKey | null; P: Pdas | null;
  program: any; readProgram: any; provider: any;
  signers: AppSigner[]; active: AppSigner | null; setActiveId: (id: string) => void;
  burners: Burner[]; addBurner: (label?: string, secret?: number[]) => void; removeBurner: (id: string) => void;
  mainnet: boolean;
  data: ChainData; refresh: () => void;
  log: LogEntry[]; clearLog: () => void;
  run: (label: string, fn: () => Promise<string | void>) => Promise<{ ok: boolean; sig?: string; err?: string }>;
  rpcOpts: () => any;
  scanHolders: () => Promise<Holder[]>;
}

const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
};

export function AppProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const [settings, setSettingsState] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...load("settings", {}) }));
  const [burners, setBurners] = useState<Burner[]>(() => load("burners", []));
  const [activeId, setActiveIdState] = useState<string>(() => load("activeId", ""));
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [data, setData] = useState<ChainData>(EMPTY);
  const counter = useRef(0);

  const setSettings = (s: Partial<Settings>) =>
    setSettingsState((prev) => {
      const next = { ...prev, ...s };
      save("settings", next);
      return next;
    });
  const setActiveId = (id: string) => { setActiveIdState(id); save("activeId", id); };
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const mainnet = settings.rpc.toLowerCase().includes("mainnet");
  const connection = useMemo(() => new Connection(settings.rpc, { commitment: "confirmed" }), [settings.rpc]);
  const programId = useMemo(() => {
    try { return new PublicKey(settings.programId); } catch { return DEFAULT_PROGRAM_ID; }
  }, [settings.programId]);
  const mint = useMemo(() => {
    try { return settings.mint ? new PublicKey(settings.mint) : null; } catch { return null; }
  }, [settings.mint]);
  const treasuryMint = useMemo(() => {
    try { return new PublicKey(settings.treasuryMint || WSOL.toBase58()); } catch { return WSOL; }
  }, [settings.treasuryMint]);
  const P = useMemo(() => (mint ? pdas(programId, mint, treasuryMint) : null), [programId, mint, treasuryMint]);

  const signers: AppSigner[] = useMemo(() => {
    const list: AppSigner[] = mainnet
      ? []
      : burners.map((b) => burnerSigner(b.id, b.label, Keypair.fromSecretKey(Uint8Array.from(b.secret))));
    if (wallet.publicKey && wallet.signTransaction && wallet.signAllTransactions) {
      const w = wallet;
      list.unshift({
        id: "phantom",
        label: `${w.wallet?.adapter.name ?? "Кошелёк"}`,
        kind: "phantom",
        publicKey: w.publicKey!,
        signTransaction: (tx: any) => w.signTransaction!(tx),
        signAllTransactions: (txs: any[]) => w.signAllTransactions!(txs),
        sendViaWallet: (tx: any, conn: Connection, options?: any) => w.sendTransaction(tx, conn, options),
      });
    }
    return list;
  }, [burners, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions, wallet.wallet, mainnet]);

  const active = signers.find((s) => s.id === activeId) ?? signers[0] ?? null;
  const provider = useMemo(() => makeProvider(connection, active), [connection, active]);
  const program = useMemo(() => makeProgram(programId, provider), [programId, provider]);
  const readProgram = useMemo(() => makeProgram(programId, makeProvider(connection, null)), [programId, connection]);

  const addBurner = (label?: string, secret?: number[]) => {
    const kp = secret ? Keypair.fromSecretKey(Uint8Array.from(secret)) : Keypair.generate();
    const id = `b-${kp.publicKey.toBase58().slice(0, 6)}`;
    setBurners((prev) => {
      if (prev.some((b) => b.id === id)) return prev;
      const next = [...prev, { id, label: label || `Кошелёк ${prev.length + 1}`, secret: Array.from(kp.secretKey) }];
      save("burners", next);
      return next;
    });
    setActiveId(id);
  };
  const removeBurner = (id: string) =>
    setBurners((prev) => {
      const next = prev.filter((b) => b.id !== id);
      save("burners", next);
      return next;
    });

  // ---------------- chain data ----------------
  useEffect(() => {
    let dead = false;
    const go = async () => {
      try {
        const slot = await connection.getSlot();
        const now = (await connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
        let mySol: number | null = null;
        if (active) mySol = (await connection.getBalance(active.publicKey)) / 1e9;
        if (!mint || !P) {
          if (!dead) setData({ ...EMPTY, loaded: true, now, mySol });
          return;
        }
        let mintInfo: MintInfo | null = null;
        try {
          const m = await getMint(connection, mint, "confirmed", TP);
          mintInfo = { decimals: m.decimals, supply: m.supply, mintAuthority: m.mintAuthority?.toBase58() ?? null };
        } catch { /* mint not there */ }
        let treasuryDecimals = 9;
        try { treasuryDecimals = (await getMint(connection, P.treasuryMint, "confirmed", TPT)).decimals; } catch { /* keep default */ }
        const treasurySymbol = P.treasuryMint.equals(WSOL) ? "SOL" : "актив казны";
        let config: any = null;
        try { config = await readProgram.account.config.fetch(P.config); } catch { /* not initialised */ }
        const bal = async (a: PublicKey, prog = TP) => {
          try { return (await getAccount(connection, a, "confirmed", prog)).amount; } catch { return null; }
        };
        const treasury = config ? await bal(P.treasury, TPT) : null;
        const fund = config && !config.milestoneFundTokenAccount.equals(PublicKey.default) ? await bal(P.milestoneFund, TPT) : null;
        const myTokens = active ? await bal(P.ata(active.publicKey)) : null;
        let pool: PoolInfo | null = null;
        if (config && !config.feePool.equals(PublicKey.default)) {
          const vaultKey: PublicKey = config.quorumExcludedAccount;
          let pending: bigint | null = null;
          try { pending = await readPendingPoolFee(connection, config.feePool, config.feePosition); } catch { /* pool not readable */ }
          pool = { pool: config.feePool, position: config.feePosition, vault: await bal(vaultKey), pending };
        }
        let proposals: ProposalRow[] = [];
        if (config) {
          const n = Number(config.proposalCount.toString());
          const pdaList = Array.from({ length: n }, (_, i) => P.proposal(i));
          const rows = n ? await readProgram.account.proposal.fetchMultiple(pdaList) : [];
          const snaps = active && n ? await readProgram.account.voterSnapshot.fetchMultiple(pdaList.map((p) => P.snap(p, active.publicKey))) : [];
          proposals = rows.map((d: any, i: number) => ({ id: i, pda: pdaList[i], data: d, mySnap: snaps[i] ?? null })).filter((r: ProposalRow) => r.data);
        }
        if (!dead) setData({ loaded: true, error: null, config, mintInfo, treasury, fund, treasuryDecimals, treasurySymbol, pool, proposals, now, myTokens: myTokens as bigint | null, mySol });
      } catch (e: any) {
        if (!dead) setData((d) => ({ ...d, loaded: true, error: describeError(e) }));
      }
    };
    go();
    const t = setInterval(go, 8000);
    return () => { dead = true; clearInterval(t); };
  }, [connection, mint, P, active?.publicKey.toBase58(), readProgram, tick]);

  // ---------------- tx runner ----------------
  const run: Ctx["run"] = async (label, fn) => {
    const n = ++counter.current;
    const who = active?.label ?? "—";
    setLog((l) => [{ n, time: Date.now(), label, who, status: "pending" as const }, ...l].slice(0, 200));
    try {
      // An external wallet with no SOL makes Phantom show scary red warnings
      // ("not enough SOL", "failed to simulate"). Stop early with a clear explanation instead.
      if (active?.kind === "phantom") {
        let lam: number | null = null;
        try { lam = await connection.getBalance(active.publicKey, "confirmed"); } catch { /* RPC hiccup: let the wallet decide */ }
        if (lam !== null && lam < MIN_SOL_LAMPORTS) {
          throw new Error(`На кошельке ${(lam / 1e9).toFixed(4)} SOL: для транзакции этого мало (нужно хотя бы ${MIN_SOL_LAMPORTS / 1e9}). Получите тестовые SOL на faucet.solana.com (нужная сеть) и повторите: тогда Phantom не покажет красных предупреждений.`);
        }
      }
      const sig = (await fn()) || undefined;
      setLog((l) => l.map((e) => (e.n === n ? { ...e, status: "ok" as const, sig } : e)));
      setTimeout(refresh, 600);
      return { ok: true, sig };
    } catch (e: any) {
      const err = describeError(e);
      setLog((l) => l.map((x) => (x.n === n ? { ...x, status: "err" as const, err } : x)));
      setTimeout(refresh, 600);
      return { ok: false, err };
    }
  };
  const rpcOpts = () => ({ skipPreflight: settings.skipPreflight, commitment: "confirmed" });

  const scanHolders = async (): Promise<Holder[]> => {
    if (!mint || !P) return [];
    const accts = await connection.getProgramAccounts(TP, {
      commitment: "confirmed",
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    });
    // ONE getProgramAccounts answer = one consistent view of all balances (the weights of a vote must describe one moment).
    // A holder with several token accounts counts through the largest one.
    const best = new Map<string, Holder>();
    for (const a of accts) {
      try {
        const u = unpackAccount(a.pubkey, a.account, TP);
        // the state itself and the pool (its vault is owned by the Meteora pool authority) cannot vote
        if (u.mint.equals(mint) && u.amount > 0n && !u.owner.equals(P.config) && !u.owner.equals(METEORA_POOL_AUTHORITY)) {
          const k = u.owner.toBase58();
          const cur = best.get(k);
          if (!cur || u.amount > cur.amount) best.set(k, { owner: u.owner, account: a.pubkey, amount: u.amount });
        }
      } catch { /* not a token account */ }
    }
    return [...best.values()].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  };

  const value: Ctx = {
    settings, setSettings, connection, programId, mint, P, program, readProgram, provider,
    signers, active, setActiveId, burners, addBurner, removeBurner, mainnet,
    data, refresh, log, clearLog: () => setLog([]), run, rpcOpts, scanHolders,
  };
  return <C.Provider value={value}>{children}</C.Provider>;
}
