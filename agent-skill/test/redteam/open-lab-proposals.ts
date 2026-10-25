// Red-team lab helper (LOCAL validator only): open the proposals from payloads.json with the owner's key.
// Every proposal enrols the listed voters from ONE read of their balances and opens the voting.
//
//   GOVERNANCE_MINT=<lab mint> ANCHOR_PROVIDER_URL=<lab rpc> ANCHOR_WALLET=<owner key file>
//   ATTACKER=<pubkey> CLEAN=<pubkey> VOTERS=<wallet>,<wallet>
//
// Run from the repository root:  npx ts-node agent-skill/test/redteam/open-lab-proposals.ts

import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { getProvider, loadProgram, createProposal, postSnapshot, openVoting } from "../../../scripts/lib/env";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const owner = provider.wallet.publicKey;
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) throw new Error(`set ${k}`);
    return v;
  };
  const attacker = new PublicKey(need("ATTACKER"));
  const clean = new PublicKey(need("CLEAN"));
  const voters = need("VOTERS").split(",").filter(Boolean).map((s) => new PublicKey(s));
  const payloads = JSON.parse(fs.readFileSync(path.join(__dirname, "payloads.json"), "utf8"));

  for (const p of payloads) {
    const reason: string = p.reason.replace(/\{ATTACKER\}/g, attacker.toBase58()).replace(/\{CLEAN\}/g, clean.toBase58());
    const bytes = Buffer.byteLength(reason);
    if (bytes > 200) throw new Error(`reason too long (${bytes} bytes) in "${p.name}"`);
    const target = p.target === "ATTACKER" ? attacker : p.target === "CLEAN" ? clean : owner;
    const { id } = await createProposal(program, provider, { type: p.type, target, amount: p.amount, paramKey: p.paramKey, reason });
    for (const v of voters) await postSnapshot(program, provider, id, v);
    await openVoting(program, provider, id);
    console.log(`PROPOSAL ${id.toString()} | ${p.name} | ${bytes} bytes`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
