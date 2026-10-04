// READ-ONLY: every proposal of the state — what it is, how the vote stands, when it can be executed. Sends nothing.
//   GOVERNANCE_MINT=<mint>  ANCHOR_PROVIDER_URL=<rpc>   (the wrappers scripts/gov_wave1*.sh set both)
import { Connection, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { GOVERNANCE_MINT, PROGRAM_ID, configPda, proposalPda, loadProgram, chainNow } from "./lib/env";

const TYPES = ["SPEND", "CHANGE_PRESIDENT", "APPOINT_FINANCE_MINISTER", "APPOINT_CULTURE_MINISTER", "CHANGE_PARAM", "CHANGE_OWNERS", "MILESTONE_DEPOSIT"];
const PARAMS = ["voting_period_secs", "proposal_threshold_bps", "quorum_spend_bps", "quorum_role_bps", "quorum_param_bps", "finance_daily_bps", "finance_weekly_bps", "culture_daily_bps", "culture_weekly_bps", "timelock_secs", "payroll_president_bps", "payroll_finance_bps", "payroll_culture_bps", "spend_cooldown_secs", "exec_fallback_secs"];
const QUORUM = (t: number, c: any) => (t === 0 || t === 6 ? c.quorumSpendBps : t >= 1 && t <= 3 ? c.quorumRoleBps : c.quorumParamBps);
const when = (s: number) => new Date(s * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК";
const left = (s: number) => { const x = Math.abs(s); const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), r = x % 60; return (h ? h + " ч " : "") + (m ? m + " мин " : "") + (!h ? r + " с" : ""); };

async function main() {
  const conn = new Connection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
  const program = loadProgram(new anchor.AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, {}));
  const c: any = await program.account.config.fetch(configPda());
  const now = await chainNow(conn);
  console.log(`Государство ${configPda().toBase58()} (программа ${PROGRAM_ID.toBase58().slice(0, 6)}…)${c.paused ? "   !!! ПАУЗА ВКЛЮЧЕНА" : ""}`);
  console.log(`Сроки сейчас: голосование ${c.votingPeriodSecs} с, ожидание после голосования ${c.timelockSecs} с, пауза между тратами ${c.spendCooldownSecs} с, запасной исполнитель через ${c.execFallbackSecs} с`);
  console.log(`Роли: президент ${c.president.toBase58().slice(0, 6)}…, финансовый министр ${c.financeMinister.equals(PublicKey.default) ? "(пусто)" : c.financeMinister.toBase58().slice(0, 6) + "…"}, культурный ${c.cultureMinister.equals(PublicKey.default) ? "(пусто)" : c.cultureMinister.toBase58().slice(0, 6) + "…"}`);
  console.log(`Всего предложений: ${c.proposalCount.toString()}   |   время цепи сейчас: ${when(now)}\n`);
  for (let i = 0; i < Number(c.proposalCount.toString()); i++) {
    const p: any = await program.account.proposal.fetch(proposalPda(i)).catch(() => null);
    if (!p) { console.log(`#${i}: (закрыто или не читается)`); continue; }
    const t = Number(p.proposalType);
    const what = t === 4 ? `CHANGE_PARAM ${PARAMS[p.paramKey] ?? p.paramKey} → ${p.amount.toString()}` : t === 0 || t === 6 ? `${TYPES[t]} ${Number(p.amount.toString()) / 1e9} SOL` : `${TYPES[t]} → ${p.target.toBase58().slice(0, 6)}…`;
    const deadline = Number(p.deadline.toString()), unlock = deadline + Number(c.timelockSecs.toString());
    const vf = BigInt(p.votesFor.toString()), va = BigInt(p.votesAgainst.toString()), base = BigInt(p.baseAtOpen.toString());
    const turnout = base > 0n ? Number(((vf + va) * 10000n) / base) / 100 : 0;
    const need = Number(QUORUM(t, c).toString()) / 100;
    let state: string;
    if (p.executed) state = "ИСПОЛНЕНО";
    else if (!p.votingOpen) state = "идёт запись избирателей (голосование ещё не открыто)";
    else if (now <= deadline) state = `идёт голосование, до конца ${left(deadline - now)}`;
    else if (now < unlock) state = `голосование закончено, ожидание, осталось ${left(unlock - now)}`;
    else state = "МОЖНО ИСПОЛНЯТЬ";
    console.log(`#${i} ${what}\n    ${state}\n    явка ${turnout}% (нужно ${need}%), «за» ${vf > va ? "больше" : vf === va ? "поровну" : "меньше"} чем «против»; голосование до ${when(deadline)}; исполнить можно с ${when(unlock)}`);
  }
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
