"use client";

// Read-only views of the lending protocol. Every value a screen shows is either a raw
// ledger field or derived here from raw fields. Redeemable assets and required cover
// are not stored on-ledger; the getters below compute them. XRPL omits zero-valued
// fields, so treat absent numbers as 0.

import { getClient } from "./xrpl-client";

const big = (v) => BigInt(v ?? "0");

/** Vault object (vault_info). Includes vault.shares.OutstandingAmount. */
export async function readVault(vaultId) {
  const client = await getClient();
  const { result } = await client.request({ command: "vault_info", vault_id: vaultId });
  return result.vault;
}

/** Any lending ledger object by its index (LoanBroker or Loan). */
export async function readLedgerEntry(index) {
  const client = await getClient();
  const { result } = await client.request({ command: "ledger_entry", index });
  return result.node;
}

export const readBroker = (brokerId) => readLedgerEntry(brokerId);
export const readLoan = (loanId) => readLedgerEntry(loanId);

/** An account's balance of the vault share MPT issuance (base-unit string). */
export async function shareBalance(account, shareMptId) {
  const client = await getClient();
  const { result } = await client.request({
    command: "account_objects",
    account,
    type: "mptoken",
  });
  const tok = (result.account_objects || []).find((o) => o.MPTokenIssuanceID === shareMptId);
  return tok ? tok.MPTAmount ?? "0" : "0";
}

// ---- derived getters (null when undefined) ----

/**
 * Assets redeemable now for `shares` shares: shares * (AssetsTotal - LossUnrealized) /
 * OutstandingShares (BigInt, base-unit drops). 0 when the vault has no shares.
 */
export function redeemableAssets(vault, shares) {
  const sharesTotal = big(vault.shares?.OutstandingAmount);
  if (sharesTotal === 0n) return 0n;
  const net = big(vault.AssetsTotal) - big(vault.LossUnrealized);
  return (big(shares) * net) / sharesTotal;
}

/** Minimum cover required now: DebtTotal * CoverRateMinimum / 100000 (BigInt). */
export function requiredCover(broker) {
  return (big(broker.DebtTotal) * big(broker.CoverRateMinimum)) / 100000n;
}
