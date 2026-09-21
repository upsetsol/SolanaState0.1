import { chromium } from "playwright-core";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
export const { Keypair } = require("@solana/web3.js");
export const results = [];
export async function start(url = process.env.WEB_URL || "http://127.0.0.1:5173") {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem("settings")) localStorage.setItem("settings", JSON.stringify({ rpc: "http://127.0.0.1:8899", skipPreflight: false }));
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  p.on("dialog", (d) => { console.log("DIALOG:", d.message()); d.dismiss(); });
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  await p.waitForSelector("nav button");
  return { b, p };
}
export function make(p) {
  const rows = () => p.locator(".log .log-r");
  const settle = async () => {
    await p.waitForFunction(() => !document.querySelector(".log-r.pending"), null, { timeout: 180000 });
    await p.waitForTimeout(500);
  };
  const top = async () => {
    const r = rows().first();
    return { cls: (await r.getAttribute("class")) || "", text: (await r.innerText()).replace(/\s*\n\s*/g, " | ") };
  };
  const tab = async (name) => { await p.locator("nav button", { hasText: name }).click(); await p.waitForTimeout(800); };
  const act = async (name, { nth = 0 } = {}) => {
    await p.getByRole("button", { name, exact: true }).nth(nth).click();
    await p.waitForTimeout(700);
    await settle();
    return top();
  };
  const check = (label, ok, note = "") => { results.push({ label, ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${label}${note ? "  — " + note : ""}`); };
  const expectOk = (label, r) => check(label, r.cls.includes("ok"), r.cls.includes("ok") ? "" : r.text);
  const expectErr = (label, r, code) => check(label, r.cls.includes("err") && r.text.includes(code), `${code} ← ${r.text.slice(-120)}`);
  const setActive = async (i) => { await p.locator("header select").selectOption({ index: i }); await p.waitForTimeout(1200); };
  const fill = async (label, value, { nth = 0 } = {}) => { await p.locator(`label.field:has(span:text-is("${label}")) input`).nth(nth).fill(String(value)); };
  const pubkeys = async () => {
    const list = await p.evaluate(() => JSON.parse(localStorage.getItem("burners") || "[]"));
    return list.map((b) => Keypair.fromSecretKey(Uint8Array.from(b.secret)).publicKey.toBase58());
  };
  const sleep = (ms) => p.waitForTimeout(ms);
  const text = async () => (await p.locator("main").innerText());
  return { rows, settle, top, tab, act, check, expectOk, expectErr, setActive, fill, pubkeys, sleep, text };
}
export function summary() {
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=========== ${pass}/${results.length} PASS ===========`);
  for (const r of results.filter((r) => !r.ok)) console.log("  FAIL:", r.label);
  return pass === results.length;
}
