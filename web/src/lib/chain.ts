import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import idl from "../../../idl/onchain_state_solana.json";

export const IDL: any = idl;
export const DEFAULT_PROGRAM_ID = new PublicKey(IDL.address);
export const TP = TOKEN_2022_PROGRAM_ID;
export const ATAP = ASSOCIATED_TOKEN_PROGRAM_ID;
export const BN = anchor.BN;

export interface AppSigner {
  id: string;
  label: string;
  kind: "phantom" | "burner";
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
  /**
   * External wallets only. Sends through the wallet adapter's sendTransaction, which tells the
   * wallet WHICH network the transaction is for (derived from the RPC URL). Plain signTransaction
   * passes no network, so Phantom simulates on its own default network and shows false red
   * warnings ("not enough SOL", "failed to simulate") even when the wallet is funded on testnet.
   */
  sendViaWallet?: (tx: Transaction, connection: Connection, options?: any) => Promise<string>;
}

export function burnerSigner(id: string, label: string, kp: Keypair): AppSigner {
  return {
    id,
    label,
    kind: "burner",
    publicKey: kp.publicKey,
    async signTransaction(tx: any) {
      if (tx instanceof Transaction) tx.partialSign(kp);
      else tx.sign([kp]);
      return tx;
    },
    async signAllTransactions(txs: any[]) {
      for (const tx of txs) {
        if (tx instanceof Transaction) tx.partialSign(kp);
        else tx.sign([kp]);
      }
      return txs;
    },
  };
}

const EXPIRED = /expired|block height exceeded|blockhash not found/i;

/** AnchorProvider that re-sends when a blockhash expires (congested public RPCs). */
export class RetryProvider extends anchor.AnchorProvider {
  private async sendViaExternalWallet(tx: Transaction, signers: any[] | undefined, opts: any): Promise<string> {
    const w: any = this.wallet;
    const conn = this.connection;
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = w.publicKey;
    let sig: string;
    try {
      sig = await w.sendViaWallet(tx, conn, {
        signers: signers?.length ? signers : undefined,
        skipPreflight: opts?.skipPreflight,
        preflightCommitment: "confirmed",
      });
    } catch (e: any) {
      // The adapter throws an empty WalletSendTransactionError when the wallet account does not
      // list this network (e.g. Phantom is not in Testnet Mode).
      if (e?.name === "WalletSendTransactionError" && !e?.message) {
        throw new Error(
          "Кошелёк не работает с выбранной сетью. В Phantom включите Testnet Mode (Настройки → Developer Settings) и выберите Solana Testnet, затем повторите."
        );
      }
      throw e;
    }
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    return sig;
  }

  async sendAndConfirm(tx: any, signers?: any[], opts?: any): Promise<string> {
    const external = (this.wallet as any)?.sendViaWallet && tx instanceof Transaction;
    for (let i = 0; ; i++) {
      try {
        if (external) return await this.sendViaExternalWallet(tx, signers, opts);
        return await super.sendAndConfirm(tx, signers, opts);
      } catch (e: any) {
        if (i < (external ? 1 : 5) && EXPIRED.test(String(e?.message ?? e))) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        throw e;
      }
    }
  }
}

export function makeProvider(conn: Connection, s: AppSigner | null): anchor.AnchorProvider {
  const dummy = Keypair.generate();
  const w: any = s ?? {
    publicKey: dummy.publicKey,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  };
  return new RetryProvider(conn, w, { commitment: "confirmed", preflightCommitment: "confirmed" });
}

export function makeProgram(programId: PublicKey, provider: anchor.AnchorProvider): any {
  return new anchor.Program({ ...IDL, address: programId.toBase58() }, provider);
}

// ---------------- PDAs ----------------

function u64le(n: number | bigint | string | anchor.BN): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n.toString()));
  return b;
}

export function pdas(programId: PublicKey, mint: PublicKey) {
  const f = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];
  const config = f([Buffer.from("config"), mint.toBuffer()]);
  return {
    config,
    treasury: getAssociatedTokenAddressSync(mint, config, true, TP, ATAP),
    milestoneFund: f([Buffer.from("milestone_fund"), config.toBuffer()]),
    ata: (owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, false, TP, ATAP),
    proposal: (id: number | bigint | string | anchor.BN) =>
      f([Buffer.from("proposal"), config.toBuffer(), u64le(id)]),
    snap: (proposal: PublicKey, voter: PublicKey) =>
      f([Buffer.from("voter_snapshot"), proposal.toBuffer(), voter.toBuffer()]),
    tracker: (role: number) => f([Buffer.from("spend_tracker"), config.toBuffer(), Buffer.from([role])]),
    payroll: (claimant: PublicKey) => f([Buffer.from("payroll"), config.toBuffer(), claimant.toBuffer()]),
    milestone: (n: number | bigint | string | anchor.BN) =>
      f([Buffer.from("milestone"), config.toBuffer(), u64le(n)]),
    mSnap: (milestone: PublicKey, holder: PublicKey) =>
      f([Buffer.from("milestone_snap"), milestone.toBuffer(), holder.toBuffer()]),
  };
}
export type Pdas = ReturnType<typeof pdas>;

// ---------------- errors ----------------

const ERRORS: { code: number; name: string; msg: string }[] = IDL.errors ?? [];

// Infrastructure-level failures (wallet/RPC/network) — happen before the contract
// ever runs, so there's no program error code to look up. Matched by a snippet of
// the raw message; explained in plain Russian, with the raw text kept for debugging.
const INFRA_ERRORS: [RegExp, string][] = [
  [
    /Attempt to debit an account but found no record of a prior credit/i,
    "На этом кошельке нет SOL в выбранной сети (он ни разу не получал SOL здесь). Возьмите тестовые SOL на faucet.solana.com (выбрать нужную сеть) и повторите.",
  ],
  [
    /insufficient funds/i,
    "Недостаточно SOL на кошельке для этой операции (комиссия/аренда счёта). Пополните через faucet.solana.com.",
  ],
  [
    /User rejected the request|user rejected|Approval Denied/i,
    "Подпись отклонена в кошельке (нажали «Отмена» или закрыли окно). Повторите и подтвердите транзакцию.",
  ],
  [
    /block height exceeded|Transaction was not confirmed|blockhash not found/i,
    "Сеть не успела подтвердить транзакцию вовремя (testnet перегружен). Просто повторите действие.",
  ],
  [
    /Attempt to load a program that does not exist|Program .* does not exist/i,
    "Программа не найдена в этой сети. Проверьте Program ID и выбранную сеть на вкладке «Настройка».",
  ],
  [
    /AccountNotFound|could not find account|Account does not exist/i,
    "Нужный счёт не найден в блокчейне. Проверьте, что токен создан и государство инициализировано (вкладка «Настройка»), и что вставлен правильный адрес.",
  ],
  [
    /WalletNotConnectedError|wallet not connected|No wallet/i,
    "Кошелёк не подключён или не выбран активным (список кошельков в шапке справа).",
  ],
  [
    /429|Too many requests|rate limit/i,
    "RPC ограничил частоту запросов. Подождите немного и повторите.",
  ],
  [
    /Failed to fetch|NetworkError|ECONNRESET|network error/i,
    "Сеть/RPC сейчас не отвечает. Подождите немного и повторите.",
  ],
];

function humanizeInfraError(text: string): string | null {
  for (const [re, ru] of INFRA_ERRORS) if (re.test(text)) return ru;
  return null;
}

export function describeError(e: any): string {
  const ec = e?.error?.errorCode;
  if (ec?.code) return `${ec.code}: ${e.error.errorMessage ?? ""}`.trim();
  const text = String(e?.message || e?.name || e);
  const m = text.match(/"Custom":\s*(\d+)/) || text.match(/custom program error: 0x([0-9a-f]+)/i);
  if (m) {
    const code = text.includes("0x") && !text.includes("Custom") ? parseInt(m[1], 16) : Number(m[1]);
    const err = ERRORS.find((x) => x.code === code);
    if (err) return `${err.name}: ${err.msg}`;
  }
  const logs: string[] | undefined = e?.logs ?? e?.transactionLogs;
  const anchorLine = logs?.find((l) => l.includes("Error Code:"));
  if (anchorLine) return anchorLine.replace(/^.*Error Code:\s*/, "");
  const infra = humanizeInfraError(text);
  if (infra) return `${infra} (${text.length > 140 ? text.slice(0, 140) + "…" : text})`;
  return text.length > 300 ? text.slice(0, 300) + "…" : text;
}

/** Extracts the short error name (e.g. "NotOwner") from describeError output. */
export function errorName(desc: string): string {
  const m = desc.match(/^([A-Za-z0-9]+):/);
  return m ? m[1] : "";
}

// ---------------- formatting ----------------

export const short = (pk?: PublicKey | string | null) => {
  if (!pk) return "—";
  const s = pk.toString();
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

export function fmtRaw(raw: bigint | number | string | anchor.BN | null | undefined, decimals: number): string {
  if (raw === null || raw === undefined) return "—";
  const v = BigInt(raw.toString());
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 4);
  return whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}

export function toRaw(ui: string, decimals: number): anchor.BN {
  const t = ui.trim().replace(/[\s,_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`Некорректное число: "${ui}"`);
  const [w, f = ""] = t.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return new anchor.BN((BigInt(w) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString());
}

export function pk(s: string, what = "адрес"): PublicKey {
  try {
    return new PublicKey(s.trim());
  } catch {
    throw new Error(`Некорректный ${what}: "${s}"`);
  }
}

export const tsFmt = (unix: number | anchor.BN) => {
  const n = Number(unix.toString());
  return n ? new Date(n * 1000).toLocaleString("ru-RU") : "—";
};

export function fmtDur(secs: number): string {
  const s = Math.abs(Math.round(secs));
  if (s < 90) return `${s} с`;
  if (s < 5400) return `${Math.round(s / 60)} мин`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} ч`;
  return `${(s / 86400).toFixed(1)} дн`;
}

export function explorerTx(rpc: string, sig: string): string {
  if (rpc.includes("testnet")) return `https://explorer.solana.com/tx/${sig}?cluster=testnet`;
  if (rpc.includes("devnet")) return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  if (rpc.includes("mainnet")) return `https://explorer.solana.com/tx/${sig}`;
  return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
}

export const PROPOSAL_TYPES = [
  "Трата из казны",
  "Сменить президента",
  "Назначить министра финансов",
  "Назначить министра культуры",
  "Сменить параметр",
  "Сменить owners_authority",
  "Пополнить фонд вех",
];

export const PARAM_KEYS = [
  "voting_period_secs (сек)",
  "proposal_threshold_bps",
  "quorum_spend_bps",
  "quorum_role_bps",
  "quorum_param_bps",
  "finance_daily_bps",
  "finance_weekly_bps",
  "culture_daily_bps",
  "culture_weekly_bps",
  "timelock_secs (сек)",
  "payroll_president_bps",
  "payroll_finance_bps",
  "payroll_culture_bps",
  "spend_cooldown_secs (сек)",
  "exec_fallback_secs (сек)",
];

export const PRESETS: Record<string, { label: string; p: Record<string, number> }> = {
  fast: {
    label: "Быстрый (секунды): для ручного тестирования",
    p: {
      votingPeriodSecs: 30, proposalThresholdBps: 100, quorumSpendBps: 300, quorumRoleBps: 1000,
      quorumParamBps: 1500, financeDailyBps: 50, financeWeeklyBps: 150, cultureDailyBps: 20,
      cultureWeeklyBps: 50, timelockSecs: 10, payrollPresidentBps: 10, payrollFinanceBps: 5,
      payrollCultureBps: 5, citizenshipThresholdBps: 25, milestoneDepositBps: 1000,
      spendCooldownSecs: 15, execFallbackSecs: 20, milestoneGraceSecs: 20,
    },
  },
  test: {
    label: "Тестовый (минуты): как PARAMS=test",
    p: {
      votingPeriodSecs: 300, proposalThresholdBps: 100, quorumSpendBps: 500, quorumRoleBps: 1000,
      quorumParamBps: 1500, financeDailyBps: 50, financeWeeklyBps: 150, cultureDailyBps: 20,
      cultureWeeklyBps: 50, timelockSecs: 60, payrollPresidentBps: 10, payrollFinanceBps: 5,
      payrollCultureBps: 5, citizenshipThresholdBps: 25, milestoneDepositBps: 1000,
      spendCooldownSecs: 120, execFallbackSecs: 3600, milestoneGraceSecs: 300,
    },
  },
  prod: {
    label: "Боевой (сутки): как PARAMS=prod",
    p: {
      votingPeriodSecs: 86400, proposalThresholdBps: 100, quorumSpendBps: 500, quorumRoleBps: 1000,
      quorumParamBps: 1500, financeDailyBps: 20, financeWeeklyBps: 50, cultureDailyBps: 10,
      cultureWeeklyBps: 30, timelockSecs: 86400, payrollPresidentBps: 5, payrollFinanceBps: 3,
      payrollCultureBps: 3, citizenshipThresholdBps: 25, milestoneDepositBps: 500,
      spendCooldownSecs: 86400, execFallbackSecs: 86400, milestoneGraceSecs: 2592000,
    },
  },
};

export const PARAM_FIELDS: [string, string][] = [
  ["votingPeriodSecs", "Голосование, сек"],
  ["proposalThresholdBps", "Порог создания предложения, bps"],
  ["quorumSpendBps", "Кворум: траты, bps"],
  ["quorumRoleBps", "Кворум: роли, bps"],
  ["quorumParamBps", "Кворум: параметры, bps"],
  ["financeDailyBps", "Минфин: в день, bps"],
  ["financeWeeklyBps", "Минфин: в неделю, bps"],
  ["cultureDailyBps", "Минкульт: в день, bps"],
  ["cultureWeeklyBps", "Минкульт: в неделю, bps"],
  ["timelockSecs", "Ожидание перед исполнением, сек"],
  ["payrollPresidentBps", "Зарплата президента, bps"],
  ["payrollFinanceBps", "Зарплата минфина, bps"],
  ["payrollCultureBps", "Зарплата минкульта, bps"],
  ["citizenshipThresholdBps", "Порог гражданина, bps"],
  ["milestoneDepositBps", "Потолок депозита в фонд вех, bps"],
  ["spendCooldownSecs", "Пауза между тратами, сек"],
  ["execFallbackSecs", "Запасное исполнение президентом, сек"],
  ["milestoneGraceSecs", "Срок выплат по вехе, сек"],
];
