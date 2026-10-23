'use strict'

// Turn instructions into an UNSIGNED transaction (base64) and dry-run it against the chain.

const web3 = require('@solana/web3.js')
const { CONFIG } = require('./config')
const { decodeProgramError } = require('./chain')

/**
 * Legacy-format transaction, fee payer = the agentic wallet, empty signature slots.
 * ONSTATE_TX_FORMAT=message outputs only the message bytes instead (for the case Binance expects that).
 */
async function buildUnsigned(connection, payer, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const message = new web3.TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToLegacyMessage()
  const vtx = new web3.VersionedTransaction(message)
  const bytes = CONFIG.txFormat === 'message' ? Buffer.from(message.serialize()) : Buffer.from(vtx.serialize())
  return { vtx, unsignedTx: bytes.toString('base64'), blockhash, lastValidBlockHeight }
}

/** Dry run on our own RPC (no signatures needed). Catches program errors before Binance is asked anything. */
async function simulate(connection, vtx) {
  const res = await connection.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  const v = res.value
  return { ok: !v.err, err: v.err, decoded: v.err ? decodeProgramError(v.err) : null, logs: v.logs || [], unitsConsumed: v.unitsConsumed }
}

module.exports = { buildUnsigned, simulate }
