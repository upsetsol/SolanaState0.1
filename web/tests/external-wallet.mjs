// Verifies the external-wallet path (what Phantom uses): the site must tell the wallet WHICH
// network the transaction is for, and create-token / initialize must work through it.
import { chromium } from "playwright-core";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { Keypair, Connection, Transaction, LAMPORTS_PER_SOL } = require("@solana/web3.js");

const kp = Keypair.generate();
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
await conn.confirmTransaction(await conn.requestAirdrop(kp.publicKey, 3 * LAMPORTS_PER_SOL), "confirmed");
const chains = [];

const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1300, height: 1000 } });
await ctx.addInitScript(() => localStorage.setItem("settings", JSON.stringify({ rpc: "http://127.0.0.1:8899", skipPreflight: false })));
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.exposeFunction("__mockSign", (bytes) => {
  const tx = Transaction.from(Buffer.from(bytes)); tx.partialSign(kp);
  return Array.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
});
await p.exposeFunction("__mockSignSend", async (bytes) => {
  const tx = Transaction.from(Buffer.from(bytes)); tx.partialSign(kp);
  await conn.sendRawTransaction(tx.serialize());
  return Array.from(tx.signature);
});
await p.exposeFunction("__mockLog", (c) => chains.push(c));
await p.addInitScript(({ addr, pub }) => {
  const icon = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#7c5cff"/></svg>');
  const ALL = ["solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"];
  const account = { address: addr, publicKey: new Uint8Array(pub), chains: ALL, features: ["solana:signTransaction", "solana:signAndSendTransaction"] };
  let connected = false;
  const wallet = {
    version: "1.0.0", name: "MockPhantom", icon, chains: ALL,
    get accounts() { return connected ? [account] : []; },
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { connected = true; return { accounts: [account] }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { connected = false; } },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs) => { inputs.forEach((i) => window.__mockLog("signTransaction:" + (i.chain || "NO-CHAIN")));
          return Promise.all(inputs.map(async (i) => ({ signedTransaction: new Uint8Array(await window.__mockSign(Array.from(i.transaction))) }))); } },
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs) => Promise.all(inputs.map(async (i) => {
          window.__mockLog("signAndSend:" + (i.chain || "NO-CHAIN"));
          return { signature: new Uint8Array(await window.__mockSignSend(Array.from(i.transaction))) }; })) },
    },
  };
  const register = (api) => api.register(wallet);
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  window.addEventListener("wallet-standard:app-ready", (e) => register(e.detail));
}, { addr: kp.publicKey.toBase58(), pub: Array.from(kp.publicKey.toBytes()) });

await p.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
await p.waitForSelector("nav button");
const ok = [];
const check = (label, cond, note = "") => { ok.push(cond); console.log(`${cond ? "PASS" : "FAIL"}  ${label}${note ? "  — " + note : ""}`); };
const settle = async () => { await p.waitForFunction(() => !document.querySelector(".log-r.pending"), null, { timeout: 60000 }); await p.waitForTimeout(600); };
const top = async () => ({ cls: (await p.locator(".log .log-r").first().getAttribute("class")) || "", text: (await p.locator(".log .log-r").first().innerText()).replace(/\s*\n\s*/g, " | ") });

await p.getByRole("button", { name: "Подключить MockPhantom" }).click();
await p.waitForTimeout(2500);
check("внешний кошелёк подключился и стал активным", (await p.locator("header select").innerText()).includes("MockPhantom"));

await p.getByRole("button", { name: "Создать токен", exact: true }).click(); await p.waitForTimeout(800); await settle();
let r = await top();
check("создание токена через внешний кошелёк", r.cls.includes("ok"), r.text);
await p.getByRole("button", { name: "Инициализировать", exact: true }).click(); await p.waitForTimeout(800); await settle();
r = await top();
check("инициализация через внешний кошелёк", r.cls.includes("ok"), r.text);

console.log("сети, которые сайт передал кошельку:", JSON.stringify(chains));
check("кошельку передана сеть (не NO-CHAIN)", chains.length > 0 && chains.every((c) => !c.includes("NO-CHAIN")));
check("сеть = localnet (по адресу RPC)", chains.every((c) => c.endsWith("solana:localnet")));
check("использован signAndSend (кошелёк знает сеть)", chains.every((c) => c.startsWith("signAndSend")));
await b.close();
console.log(ok.every(Boolean) ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok.every(Boolean) ? 0 : 1);
