// Negative: try to create a SPEND proposal well above the 30% treasury cap.
// Expect ExceedsSpendCap at creation time.
//
//   GOVERNANCE_MINT=<mint>

import { anchor, getProvider, loadProgram, createProposal, treasuryAta } from "./lib/env";
import { getAccount, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function main() {
  const provider = getProvider();
  const program = loadProgram(provider);
  const me = provider.wallet.publicKey;

  const treasury = await getAccount(
    provider.connection,
    treasuryAta(),
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  const cap = (BigInt(treasury.amount) * 30n) / 100n;
  const request = new anchor.BN(((cap * 3n) / 2n).toString()); // 1.5x the cap
  console.log(`Treasury ${treasury.amount}, 30% cap ${cap}, requesting ${request.toString()}`);

  try {
    await createProposal(program, provider, {
      type: 0,
      target: me,
      amount: request,
      reason: "Should fail — exceeds spend cap",
    });
    console.log("❌ PROBLEM: proposal created, expected a failure");
  } catch (e: any) {
    const msg = e.error?.errorCode?.code ?? e.message;
    console.log("create_proposal failed with:", msg, msg === "ExceedsSpendCap" ? "✅" : "❌");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
