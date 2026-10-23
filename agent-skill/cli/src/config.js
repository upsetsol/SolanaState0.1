'use strict'

// Configuration comes from environment variables, with defaults for the live test state ("Test 2", on Solana mainnet).
//
//   ONSTATE_RPC_URL       Solana RPC (default: the public mainnet endpoint; use your own provider for heavy use)
//   ONSTATE_MINT          governance coin of the state to work with (default: Test 2)
//   ONSTATE_PROGRAM       program id (default: the address inside the bundled IDL)
//   ONSTATE_BAW_CHAIN_ID  Binance chain id used for `baw` calls (default CT_501 = Solana)
//   ONSTATE_TX_FORMAT     "tx" (default: serialized transaction with empty signature slots) or "message"
//                         (only the message bytes). Only change it if Binance rejects the default format.

const IDL = require('../idl/onchain_state_solana.json')

const DEFAULT_MINT = '27E6pfrdS8dUTzkB2M84MCfdG782oV227UCCQ6wBKcNP' // Test 2 ("TST") on mainnet

const CONFIG = {
  rpc: process.env.ONSTATE_RPC_URL || 'https://api.mainnet-beta.solana.com',
  mint: process.env.ONSTATE_MINT || DEFAULT_MINT,
  program: process.env.ONSTATE_PROGRAM || IDL.address,
  chainId: process.env.ONSTATE_BAW_CHAIN_ID || 'CT_501',
  txFormat: (process.env.ONSTATE_TX_FORMAT || 'tx').toLowerCase(),
}

module.exports = { CONFIG, IDL }
