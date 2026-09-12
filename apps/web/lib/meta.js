"use client";

// Transaction-metadata helpers. A wallet's signAndSubmit returns only a hash, so to
// learn a created object's ledger index (or the create's Sequence for escrows) we
// read the validated transaction back by hash.

import { getClient } from "./xrpl-client";

/** LedgerIndex of the first created object of `entryType` in tx metadata, or null. */
export function createdIndex(meta, entryType) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  return null;
}

/** The MPTokenIssuanceID from MPTokenIssuanceCreate metadata, or null. */
export const mptIssuanceId = (meta) => meta?.mpt_issuance_id ?? null;

/** Read a validated transaction by hash. Returns { meta, tx }. Bounded poll. */
export async function readTx(hash) {
  const client = await getClient();
  for (let guard = 0; guard < 40; guard += 1) {
    try {
      const { result } = await client.request({ command: "tx", transaction: hash });
      if (result.validated) return { meta: result.meta, tx: result.tx_json || result };
    } catch {
      // txnNotFound until validated.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`readTx: ${hash} not validated in time`);
}
