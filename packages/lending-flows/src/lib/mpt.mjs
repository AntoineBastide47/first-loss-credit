// Shared builders for XLS-33 Multi-Purpose Tokens (MPTs). These
// belong to no flow; a flow imports them like any library and never imports
// another flow.

import { MPTokenIssuanceCreateFlags } from "xrpl";
import { submitAndWait } from "./index.mjs";

// Issuance creation flags. The MPTokenIssuance ledger object stores these at the same
// bit positions (lsfMPTCanTransfer = tfMPTCanTransfer = 32, etc.), so the same enum
// reads back the object's Flags.
export { MPTokenIssuanceCreateFlags };

// MPToken (holder) flag (ripple-binary-codec: lsfMPTAuthorized = 2). The issuer's
// MPTokenAuthorize sets it on the holder's MPToken when the issuance requires auth.
export const LSF_MPT_AUTHORIZED = 0x0002;

/** True if a holder's MPToken object carries the issuer-authorized flag. */
export const isMptAuthorized = (mptoken) =>
  (Number(mptoken?.Flags ?? 0) & LSF_MPT_AUTHORIZED) !== 0;

/**
 * MPTokenIssuanceCreate by `issuer`. opts: { flags, assetScale, maximumAmount,
 * transferFee, metadata (hex) }. Returns { hash, meta, issuanceId }.
 */
export async function createMptIssuance(client, issuer, opts = {}) {
  const tx = { TransactionType: "MPTokenIssuanceCreate", Account: issuer.address };
  if (opts.flags !== undefined) tx.Flags = opts.flags;
  if (opts.assetScale !== undefined) tx.AssetScale = opts.assetScale;
  if (opts.maximumAmount !== undefined) tx.MaximumAmount = opts.maximumAmount;
  if (opts.transferFee !== undefined) tx.TransferFee = opts.transferFee;
  if (opts.metadata !== undefined) tx.MPTokenMetadata = opts.metadata;
  const res = await submitAndWait(client, tx, issuer);
  const issuanceId = res.meta.mpt_issuance_id;
  if (!issuanceId) throw new Error("MPTokenIssuanceCreate metadata missing mpt_issuance_id");
  return { hash: res.hash, meta: res.meta, issuanceId };
}

/**
 * MPTokenAuthorize. Holder opt-in: `account` = the holder, no `holder` option. Issuer
 * authorize: `account` = the issuer, `holder` = the opting-in holder. Returns
 * { hash, meta }.
 */
export async function authorizeMpt(client, account, issuanceId, { holder } = {}) {
  const tx = {
    TransactionType: "MPTokenAuthorize", Account: account.address, MPTokenIssuanceID: issuanceId,
  };
  if (holder) tx.Holder = holder.address ?? holder;
  return submitAndWait(client, tx, account);
}

/** Read the MPTokenIssuance object by id. */
export async function readMptIssuance(client, issuanceId) {
  const { result } = await client.request({
    command: "ledger_entry", mpt_issuance: issuanceId, ledger_index: "validated",
  });
  return result.node;
}

/** Read a holder's MPToken object, or null if none exists. */
export async function readMptoken(client, holder, issuanceId) {
  try {
    const { result } = await client.request({
      command: "ledger_entry",
      mptoken: { mpt_issuance_id: issuanceId, account: holder.address ?? holder },
      ledger_index: "validated",
    });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

/** A holder's MPT balance as a string ("0" if no MPToken). */
export async function mptBalance(client, holder, issuanceId) {
  const tok = await readMptoken(client, holder, issuanceId);
  return tok ? tok.MPTAmount ?? "0" : "0";
}
