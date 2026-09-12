"use client";

// Reads for XLS-33 Multi-Purpose Tokens. MPTAmount is the spendable balance;
// LockedAmount (escrow) is additive, not subtracted.

import { getClient } from "./xrpl-client";

export const LSF_MPT_AUTHORIZED = 0x0002;
export const isMptAuthorized = (tok) => (Number(tok?.Flags ?? 0) & LSF_MPT_AUTHORIZED) !== 0;

export async function readMptIssuance(issuanceId) {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "ledger_entry", mpt_issuance: issuanceId, ledger_index: "validated" });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

export async function readMptoken(account, issuanceId) {
  const client = await getClient();
  try {
    const { result } = await client.request({ command: "ledger_entry", mptoken: { mpt_issuance_id: issuanceId, account }, ledger_index: "validated" });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

export async function mptBalance(account, issuanceId) {
  const tok = await readMptoken(account, issuanceId);
  return tok ? tok.MPTAmount ?? "0" : "0";
}
