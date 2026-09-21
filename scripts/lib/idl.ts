// Reads the program IDL without needing GOVERNANCE_MINT (create_mint.ts runs before
// a mint exists). Fresh build output wins; otherwise the committed copy in idl/, so a
// plain clone works without Rust/Anchor. After changing the program:
//   cp target/idl/onchain_state_solana.json idl/
import * as fs from "fs";

const BUILT_IDL = "./target/idl/onchain_state_solana.json";
const COMMITTED_IDL = "./idl/onchain_state_solana.json";
export const IDL_PATH = fs.existsSync(BUILT_IDL) ? BUILT_IDL : COMMITTED_IDL;

export function readIdl(): any {
  if (!fs.existsSync(IDL_PATH)) {
    throw new Error(`${IDL_PATH} not found (neither target/idl nor idl/).`);
  }
  return JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
}
