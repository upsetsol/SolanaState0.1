// READ-ONLY report: for every proposal of the state - what it was, how the vote went, and the transactions that confirm each stage
// (created, voters enrolled, voting opened, every vote, EXECUTED, closed) with Solscan links. Sends nothing.
//   GOVERNANCE_MINT=<mint>  ANCHOR_PROVIDER_URL=<rpc>  [FROM=<first id>] [OUT=<markdown file>]   (the wrappers scripts/gov_wave*.sh set the first two)
// The history is read from the chain by the address of each proposal (it stays readable after the account is closed).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { GOVERNANCE_MINT, PROGRAM_ID, configPda, proposalPda, loadProgram, chainNow, makeConnection } from "./lib/env";

const TYPES = ["SPEND", "CHANGE_PRESIDENT", "APPOINT_FINANCE_MINISTER", "APPOINT_CULTURE_MINISTER", "CHANGE_PARAM", "CHANGE_OWNERS", "MILESTONE_DEPOSIT"];
const PARAMS = ["voting_period_secs", "proposal_threshold_bps", "quorum_spend_bps", "quorum_role_bps", "quorum_param_bps", "finance_daily_bps", "finance_weekly_bps", "culture_daily_bps", "culture_weekly_bps", "timelock_secs", "payroll_president_bps", "payroll_finance_bps", "payroll_culture_bps", "spend_cooldown_secs", "exec_fallback_secs"];
const QUORUM = (t: number, c: any) => (t === 0 || t === 6 ? c.quorumSpendBps : t >= 1 && t <= 3 ? c.quorumRoleBps : c.quorumParamBps);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msk = (s: number | null | undefined) => (s ? new Date(s * 1000).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" }) + " МСК" : "?");
const names = new Map<string, string>();   // address -> role, so that the list reads as a story, not as a row of addresses
const short = (k: string) => (names.has(k) ? names.get(k) + " " : "") + k.slice(0, 4) + "…" + k.slice(-4);
const coins = (raw: bigint) => (Number(raw / 1_000_000n) / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 0 });
const URL = (sig: string) => `https://solscan.io/tx/${sig}`;
const retry = async <T>(f: () => Promise<T>): Promise<T> => { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 9) throw e; await sleep(Math.min(1500 * (i + 1), 10000)); } } };   // a long outage of the public RPC must not lose the whole report

type Ev = { kind: string; sig: string; time: number | null | undefined; who: string; detail: string };

async function main() {
  const conn = makeConnection(process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899", "confirmed");
  const program = loadProgram(new anchor.AnchorProvider(conn, { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, {}));
  const cfg: any = await retry(() => program.account.config.fetch(configPda()));
  const count = Number(cfg.proposalCount.toString());
  const from = Number(process.env.FROM ?? "0");
  names.set(cfg.ownersAuthority.toBase58(), "владелец");
  if (!cfg.financeMinister.equals(PublicKey.default)) names.set(cfg.financeMinister.toBase58(), "фин.министр");
  if (!cfg.cultureMinister.equals(PublicKey.default)) names.set(cfg.cultureMinister.toBase58(), "министр культуры");
  // helper wallets of the checks (only the PUBLIC half of a key file is used: bytes 32..64 of a Solana keypair file)
  const dir = (process.env.GOV_WALLETS ?? "~/gov-test-wallets").replace(/^~/, os.homedir());
  for (const [file, role] of [["citizen", "гражданин"], ["president-test", "тестовый президент"]]) {
    try { const b = JSON.parse(fs.readFileSync(path.join(dir, file + ".json"), "utf8")); names.set(new PublicKey(Uint8Array.from(b.slice(32, 64))).toBase58(), role); } catch { /* no such helper */ }
  }
  const now = await retry(() => chainNow(conn));
  const out: string[] = [];
  const say = (s = "") => { console.log(s); out.push(s); };
  say(`# Голосования государства ${configPda().toBase58()} (монета ${GOVERNANCE_MINT.toBase58()}, программа ${PROGRAM_ID.toBase58()})`);
  say(`Состояние на ${msk(now)}. Всего предложений: ${count}. Подпись транзакции открывается так: ${URL("<подпись>")}\n`);

  const summary: string[] = [];
  const blocks: string[][] = [];
  for (let id = from; id < count; id++) {
    const pda = proposalPda(id);
    const p: any = await retry(() => program.account.proposal.fetchNullable(pda));
    const sigs = await retry(() => conn.getSignaturesForAddress(pda, { limit: 200 }, "confirmed"));
    const events: Ev[] = [];
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const t: any = await retry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
      if (!t || t.meta?.err) continue;
      const msg: any = t.transaction.message;
      const keys: PublicKey[] = msg.staticAccountKeys;
      const ix = (msg.compiledInstructions as any[]).find((i) => keys[i.programIdIndex].equals(PROGRAM_ID));
      if (!ix) continue;
      // our instruction's own log line (other programs in the same transaction - the token program, the account creation - log "Instruction: ..." too)
      const name = ((t.meta.logMessages as string[]).find((l) => /Program log: Instruction: (CreateProposal|PostVoterSnapshot|OpenVoting|Vote|ExecuteProposal|CloseProposal|CloseVoterSnapshot)$/.test(l)) ?? "").replace(/.*Instruction: /, "");
      const data = Buffer.from(ix.data);
      const who = keys[0].toBase58();
      if (name === "CreateProposal") events.push({ kind: "создано", sig: s.signature, time: s.blockTime, who, detail: "" });
      else if (name === "PostVoterSnapshot") events.push({ kind: "внесён в список голосующих", sig: s.signature, time: s.blockTime, who: new PublicKey(data.subarray(16, 48)).toBase58(), detail: `вес ${coins(data.readBigUInt64LE(48) * 1n)} монет` });
      else if (name === "OpenVoting") events.push({ kind: "голосование открыто", sig: s.signature, time: s.blockTime, who, detail: "" });
      else if (name === "Vote") events.push({ kind: "голос", sig: s.signature, time: s.blockTime, who, detail: data[16] === 1 ? "ЗА" : "ПРОТИВ" });
      else if (name === "ExecuteProposal") events.push({ kind: "ИСПОЛНЕНО", sig: s.signature, time: s.blockTime, who, detail: "" });
      else if (name === "CloseProposal") events.push({ kind: "аккаунт закрыт (залог возвращён)", sig: s.signature, time: s.blockTime, who, detail: "" });
      else if (name === "CloseVoterSnapshot") events.push({ kind: "запись голосующего закрыта", sig: s.signature, time: s.blockTime, who, detail: "" });
      await sleep(120);
    }
    const exec = events.find((e) => e.kind === "ИСПОЛНЕНО");
    let what = `#${id}`, result = "";
    if (p) {
      const t = Number(p.proposalType);
      what = `#${id} ${t === 4 ? `CHANGE_PARAM ${PARAMS[p.paramKey] ?? p.paramKey} → ${p.amount.toString()}` : t === 0 || t === 6 ? `${TYPES[t]} ${Number(p.amount.toString()) / 1e9} SOL` : `${TYPES[t]} → ${p.target.toBase58().slice(0, 6)}…`}`;
      const vf = BigInt(p.votesFor.toString()), va = BigInt(p.votesAgainst.toString()), base = BigInt(p.baseAtOpen.toString());
      const deadline = Number(p.deadline.toString());
      const turnout = base > 0n ? Number(((vf + va) * 10000n) / base) / 100 : 0;
      const need = Number(QUORUM(t, cfg).toString()) / 100;
      result = p.executed ? "ИСПОЛНЕНО" : !p.votingOpen ? "голосование не открывалось" : now <= deadline ? "голосование идёт" : turnout < need ? "НЕ ИСПОЛНЕНО: не набрался кворум" : vf > va ? "прошло, ждёт исполнения" : "НЕ ИСПОЛНЕНО: голосование проиграно (против ≥ за)";
      blocks.push([
        `## ${what} — ${result}`,
        `- За: ${coins(vf)} монет, против: ${coins(va)} монет, явка ${turnout}% (нужно ${need}%), голосование было до ${msk(deadline)}`,
        ...events.map((e) => `- ${e.kind}${e.who && e.kind !== "создано" ? " " + short(e.who) : ""}${e.detail ? " (" + e.detail + ")" : ""} — ${msk(e.time)} — ${URL(e.sig)}`),
        ...(p.executed || !p.votingOpen || now <= deadline ? [] : [`- (исполнения нет: контракт не даёт исполнить такое предложение — проверка отказа выполнялась отдельно, на сети от неё следа нет)`]),
        "",
      ]);
    } else {
      what = `#${id} (аккаунт закрыт)`;
      result = exec ? "ИСПОЛНЕНО (аккаунт потом закрыт, залог возвращён)" : "закрыто";
      blocks.push([`## ${what} — ${result}`, ...events.map((e) => `- ${e.kind}${e.who && e.kind !== "создано" ? " " + short(e.who) : ""}${e.detail ? " (" + e.detail + ")" : ""} — ${msk(e.time)} — ${URL(e.sig)}`), ""]);
    }
    summary.push(`| ${what} | ${result} | ${exec ? URL(exec.sig) : "—"} |`);
  }
  say("## Сводка: какая транзакция подтверждает исполнение");
  say("| предложение | итог | транзакция исполнения |");
  say("|---|---|---|");
  summary.forEach((l) => say(l));
  say();
  blocks.forEach((b) => b.forEach((l) => say(l)));
  if (process.env.OUT) { fs.writeFileSync(process.env.OUT, out.join("\n") + "\n"); console.log(`\nsaved: ${process.env.OUT}`); }
}
main().catch((e) => { console.error(String(e?.message ?? e).replace(/api-key=[A-Za-z0-9-]+/g, "api-key=***")); process.exit(1); });
