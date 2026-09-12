"use client";

// Reads for XLS-85 token escrows. Addressed by (owner, offerSequence).

import { getClient } from "./xrpl-client";

export async function readEscrow(owner, offerSequence) {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "ledger_entry", escrow: { owner, seq: Number(offerSequence) }, ledger_index: "validated" });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}
