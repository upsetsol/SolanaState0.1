// Reads audit/results_*.json (the last run, v4.1) and audit/results_v4/results_*.json (the first run, v4 = mainnet "Test 1")
// and prints the counts per file and every row that is not a plain BLOCKED/OK/INFO — the table that REPORT.md summarises.
//   npx ts-node audit/summary.ts
import * as fs from "fs";
import * as path from "path";

interface Row { group: string; id: string; title: string; verdict: string; note?: string; status?: string }
const dir = path.join(__dirname);
const load = (d: string): Record<string, Row[]> => {
  const out: Record<string, Row[]> = {};
  if (!fs.existsSync(d)) return out;
  for (const f of fs.readdirSync(d).filter((x) => /^results_.*\.json$/.test(x)).sort()) out[f.replace(/^results_|\.json$/g, "")] = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
  return out;
};
const now = load(dir);
const old = load(path.join(dir, "results_v4"));
const count = (rows: Row[] = []) => {
  const c: Record<string, number> = { BLOCKED: 0, EXPLOITABLE: 0, OK: 0, INFO: 0, ERROR: 0 };
  for (const r of rows) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return c;
};
const fmt = (c: Record<string, number>) => `BLOCKED ${String(c.BLOCKED).padStart(3)} | EXPLOITABLE ${String(c.EXPLOITABLE).padStart(2)} | OK ${String(c.OK).padStart(2)} | INFO ${String(c.INFO).padStart(2)} | ERROR ${c.ERROR}`;

console.log("file      v4 (first run)                                                  → v4.1 (this run)");
const tot = { old: { BLOCKED: 0, EXPLOITABLE: 0, OK: 0, INFO: 0, ERROR: 0 } as Record<string, number>, now: { BLOCKED: 0, EXPLOITABLE: 0, OK: 0, INFO: 0, ERROR: 0 } as Record<string, number> };
for (const k of [...new Set([...Object.keys(old), ...Object.keys(now)])].sort()) {
  const co = count(old[k]), cn = count(now[k]);
  for (const v of Object.keys(tot.old)) { tot.old[v] += co[v] ?? 0; tot.now[v] += cn[v] ?? 0; }
  console.log(`${k.padEnd(8)}  ${old[k] ? fmt(co) : "—".padEnd(56)}  →  ${now[k] ? fmt(cn) : "—"}`);
}
console.log(`${"TOTAL".padEnd(8)}  ${fmt(tot.old)}  →  ${fmt(tot.now)}`);
const nowRows = Object.values(now).flat();
const st: Record<string, number> = {};
for (const r of nowRows) if (r.status) st[r.status] = (st[r.status] ?? 0) + 1;
console.log("\nstatus of the rows of this run:", st);
console.log("\nEXPLOITABLE rows of this run (each must carry a status):");
for (const r of nowRows.filter((x) => x.verdict === "EXPLOITABLE")) console.log(`  [${r.id}] {${r.status || "NO STATUS"}} ${r.title}`);
console.log("\nFIXED rows (worked against v4, blocked by v4.1):");
for (const r of nowRows.filter((x) => x.status === "FIXED")) console.log(`  [${r.id}] ${r.title}`);
const bad = nowRows.filter((x) => x.verdict === "ERROR" || (x.verdict === "EXPLOITABLE" && !x.status));
if (bad.length) { console.log("\n❗ UNEXPECTED rows:"); for (const r of bad) console.log(`  [${r.id}] ${r.verdict} ${r.note ?? ""}`); process.exitCode = 1; }
