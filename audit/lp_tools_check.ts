// Local rehearsal of the liquidity tools (scripts/send_coins, add_liquidity, pool_report, claim_pool_fees, remove_liquidity)
// on a replica of mainnet "Test 1" (pool = 1,000,000 coins + 0.02 SOL, locked, registered). Local validator only.
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 npx ts-node audit/lp_tools_check.ts
import { execSync } from "child_process";
import * as fs from "fs";
import { makeWorld, group, record, SOL, COIN, RPC, conn, finish } from "./lib";

async function main() {
  group("LP tools rehearsal");
  const dir = process.env.LP_TMP ?? "/tmp/lp-check";
  fs.mkdirSync(dir, { recursive: true });
  const w = await makeWorld({ name: "lp" });
  await w.withPool(1_000_000n, SOL / 50n);
  const lpw = await w.holder(0n, 5);
  const trader = await w.holder(0n, 50);
  const key = (n: string, k: any) => { const f = `${dir}/${n}.json`; fs.writeFileSync(f, JSON.stringify(Array.from(k.secretKey))); return f; };
  const deployerKey = key("deployer", w.payer), lpKey = key("lp", lpw);
  const run = (script: string, env: Record<string, string>) =>
    execSync(`npx ts-node scripts/${script}.ts 2>&1`, { env: { ...process.env, ANCHOR_PROVIDER_URL: RPC, GOVERNANCE_MINT: w.mint.publicKey.toBase58(), ANCHOR_WALLET: deployerKey, ...env }, encoding: "utf8" });
  const show = (title: string, out: string) => console.log(`\n----- ${title}\n${out.trim()}`);

  await w.swap(trader, "buy", SOL / 200n); // like the 0.005 SOL test buy of Test 1
  show("send_coins (dry run)", run("send_coins", { KEYPAIR: deployerKey, TO: lpw.publicKey.toBase58(), AMOUNT: "30000000" }));
  show("send_coins", run("send_coins", { KEYPAIR: deployerKey, TO: lpw.publicKey.toBase58(), AMOUNT: "30000000", CONFIRM: "yes" }));
  show("claim_pool_fees (start from zero)", run("claim_pool_fees", { KEYPAIR: deployerKey }));
  show("pool_report BEFORE", run("pool_report", { LP_WALLET: lpw.publicKey.toBase58(), REPORT_OUT: `${dir}/before.json` }));
  show("add_liquidity (dry run)", run("add_liquidity", { KEYPAIR: lpKey, SOL_AMOUNT: "0.5" }));
  const solBefore = await conn.getBalance(lpw.publicKey), coinsBefore = await w.bal(w.ata(lpw.publicKey));
  show("add_liquidity", run("add_liquidity", { KEYPAIR: lpKey, SOL_AMOUNT: "0.5", CONFIRM: "yes" }));
  await w.swap(trader, "buy", SOL / 10n); // Nikita's buy: 0.1 SOL
  show("pool_report AFTER the 0.1 SOL buy", run("pool_report", { LP_WALLET: lpw.publicKey.toBase58(), REPORT_PREV: `${dir}/before.json` }));
  show("claim_pool_fees (treasury share)", run("claim_pool_fees", { KEYPAIR: deployerKey }));
  show("remove_liquidity (dry run)", run("remove_liquidity", { KEYPAIR: lpKey }));
  show("remove_liquidity", run("remove_liquidity", { KEYPAIR: lpKey, CONFIRM: "yes" }));
  const solAfter = await conn.getBalance(lpw.publicKey), coinsAfter = await w.bal(w.ata(lpw.publicKey));
  record("LP.1", "round trip of the LP wallet (add 0.5 SOL, a 0.1 SOL buy happens, remove everything)", "INFO",
    `SOL ${(solBefore / 1e9).toFixed(4)} → ${(solAfter / 1e9).toFixed(4)} (wallet SOL incl. the position rent refund); coins ${Number(coinsBefore / COIN)} → ${Number(coinsAfter / COIN)}`);
  finish("audit/results_lp_tools.json");
}
main().catch((e) => { console.error(e?.stdout ?? e); process.exit(1); });
