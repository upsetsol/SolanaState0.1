// Shared helpers of the "wave 2" governance checks (scripts/gov_wave2.ts): state file, log, wallets and "the contract must refuse" checks.
import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { expandHome, isTransientNetworkError } from "./env";

export const WALLETS_DIR = expandHome(process.env.GOV_WALLETS ?? "~/gov-test-wallets");
export const STATE_FILE = expandHome(process.env.GOV2_STATE ?? "~/gov-wave2.state.json");
export const LOG_FILE = expandHome(process.env.GOV2_LOG ?? "~/gov-wave2.log");
export const CONFIRM = process.env.CONFIRM === "yes";

/** What has been done so far. Written BEFORE a proposal/milestone is created, so a dropped connection never leads to a duplicate. */
export type State = {
  ids: Record<string, number>;          // proposal label -> id
  pending: Record<string, number>;      // proposal label -> id it WILL get (written before sending)
  milestone?: number;                   // milestone number created by this wave
  pendingMilestone?: number;
  done: Record<string, string>;         // one-off checks that were already performed
};
export function loadState(): State {
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); return { ids: {}, pending: {}, done: {}, ...s }; }
  catch { return { ids: {}, pending: {}, done: {} }; }
}
export function saveState(s: State): void {
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}

export function walletFile(name: string): string { return path.join(WALLETS_DIR, name + ".json"); }
export function createWalletFile(name: string): Keypair {
  fs.mkdirSync(WALLETS_DIR, { recursive: true, mode: 0o700 });
  const kp = Keypair.generate();
  fs.writeFileSync(walletFile(name), JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: "wx" });
  return kp;
}

/** Console + the journal file (~/gov-wave2.log): every transaction of the wave is listed there with its label. */
export function log(line: string): void {
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + line + "\n"); } catch { /* the journal is a convenience */ }
}
export function tx(label: string, sig: string): string { log(`TX    ${label.padEnd(44)} ${sig}`); return sig; }

export const results = { pass: 0, fail: 0, inconclusive: 0 };
export function pass(msg: string): void { results.pass++; log("PASS  " + msg); }
export function fail(msg: string): void { results.fail++; log("FAIL  " + msg); }
export function note(msg: string): void { log("      " + msg); }

/** The Anchor error code of a failed call ("Paused", "NotOwner", ...), or the start of the message. */
export function errCode(e: any): string {
  const direct = e?.error?.errorCode?.code ?? e?.errorCode?.code;
  if (direct) return String(direct);
  const hay = [e?.message, ...(Array.isArray(e?.logs) ? e.logs : []), ...(Array.isArray(e?.transactionLogs) ? e.transactionLogs : [])].join("\n");
  return hay.match(/Error Code: (\w+)/)?.[1] ?? hay.match(/custom program error: (0x[0-9a-f]+)/i)?.[1] ?? ("unknown: " + String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160));
}

/** The call MUST be refused with one of `codes` (a check that the contract protects itself). A network drop is "inconclusive", not a failure. */
export async function expectRefused(label: string, codes: string | string[], fn: () => Promise<any>): Promise<boolean> {
  const want = Array.isArray(codes) ? codes : [codes];
  try {
    const sig = await fn();
    fail(`${label}: it WAS accepted (expected ${want.join("/")}) tx ${sig}`);
    return false;
  } catch (e: any) {
    if (isTransientNetworkError(e)) { results.inconclusive++; log(`SKIP  ${label}: network drop, run the same command again`); return false; }
    const got = errCode(e);
    if (want.includes(got)) { pass(`${label}: refused by the contract (${got})`); return true; }
    fail(`${label}: expected ${want.join("/")}, got ${got}`);
    return false;
  }
}

export function summary(step: string): number {
  log(`\n=== ${step}: ${results.pass} passed, ${results.fail} FAILED, ${results.inconclusive} inconclusive (network) ===`);
  return results.fail > 0 ? 1 : 0;
}
