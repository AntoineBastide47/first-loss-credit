// Shared, phase-agnostic builders for XLS-85 TokenEscrow. These belong to no phase;
// a phase imports them like any library and never imports another phase.

import { createHash, randomBytes } from "node:crypto";

/**
 * Build a PREIMAGE-SHA-256 crypto-condition and its fulfillment (hex, uppercase).
 * Dependency-free: for a 32-byte preimage the DER encoding is fixed, so no
 * crypto-conditions library is needed.
 *   fulfillment = A0 22 80 20 <preimage32>
 *   condition   = A0 25 80 20 <sha256(preimage)> 81 01 20   (cost = 32)
 * Returns { condition, fulfillment }.
 */
export function makeCondition() {
  const preimage = randomBytes(32);
  const hash = createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return {
    condition: `A0258020${hash}810120`,
    fulfillment: `A0228020${preimage.toString("hex").toUpperCase()}`,
  };
}

/**
 * EscrowCreate by `owner`. opts: { amount, destination, finishAfter, cancelAfter,
 * condition, destinationTag }. Autofills first to capture the create Sequence, which
 * finish/cancel need as OfferSequence. Throws on non-tesSUCCESS. Returns
 * { hash, meta, sequence }.
 */
export async function createEscrow(client, owner, opts) {
  const tx = {
    TransactionType: "EscrowCreate",
    Account: owner.address,
    Amount: opts.amount,
    Destination: opts.destination.address ?? opts.destination,
  };
  if (opts.finishAfter !== undefined) tx.FinishAfter = opts.finishAfter;
  if (opts.cancelAfter !== undefined) tx.CancelAfter = opts.cancelAfter;
  if (opts.condition) tx.Condition = opts.condition;
  if (opts.destinationTag !== undefined) tx.DestinationTag = opts.destinationTag;
  const prepared = await client.autofill(tx);
  const sequence = prepared.Sequence;
  const res = await client.submitAndWait(owner.sign(prepared).tx_blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`EscrowCreate failed: ${code} (${res.result.hash})`);
  return { hash: res.result.hash, meta: res.result.meta, sequence };
}

/**
 * EscrowFinish tx object. Any account may submit it; a crypto-condition, not the
 * submitter, controls release. Include condition + fulfillment for a conditioned
 * escrow. Build the object here so happy-path (submitAndWait) and negative-control
 * (submitExpectingFailure) submits share one shape.
 */
export function escrowFinishTx(submitter, { owner, offerSequence, condition, fulfillment }) {
  const tx = {
    TransactionType: "EscrowFinish",
    Account: submitter.address,
    Owner: owner.address ?? owner,
    OfferSequence: offerSequence,
  };
  if (condition) tx.Condition = condition;
  if (fulfillment) tx.Fulfillment = fulfillment;
  return tx;
}

/** Read the Escrow object by (owner, offerSequence), or null if none exists. */
export async function readEscrow(client, owner, offerSequence) {
  try {
    const { result } = await client.request({
      command: "ledger_entry",
      escrow: { owner: owner.address ?? owner, seq: offerSequence },
      ledger_index: "validated",
    });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

/** EscrowCancel tx object (valid only after CancelAfter; returns the token to owner). */
export const escrowCancelTx = (submitter, { owner, offerSequence }) => ({
  TransactionType: "EscrowCancel",
  Account: submitter.address,
  Owner: owner.address ?? owner,
  OfferSequence: offerSequence,
});
