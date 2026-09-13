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

/**
 * True when a loan is fully repaid. A settled Loan object stays on the ledger with its
 * balances omitted (XRPL drops zero values), while fixed term fields like PeriodicPayment
 * remain. Reading those leftovers as an amount due makes a closed loan look overdue.
 */
export const isSettled = (loan) =>
  !!loan && !Number(loan.PaymentRemaining ?? 0) && !Number(loan.PrincipalOutstanding ?? 0);

/** Every object of `type` owned by `account`, following markers. Bounded. */
async function ownedObjects(account, type) {
  const client = await getClient();
  const out = [];
  let marker;
  for (let i = 0; i < 20; i += 1) {
    const { result } = await client.request({
      command: "account_objects", account, type, limit: 400, ...(marker ? { marker } : {}),
    });
    out.push(...(result.account_objects || []));
    marker = result.marker;
    if (!marker) break;
  }
  return out;
}

/**
 * Every loan a broker has made, read from the ledger. A LoanBroker has a pseudo-account
 * (`broker.Account`) that owns its Loan objects, so the book does not depend on what this
 * browser happens to remember. Returns [{ id, loan }].
 */
export async function brokerLoans(brokerId) {
  const client = await getClient();
  let pseudo;
  try {
    const { result } = await client.request({ command: "ledger_entry", index: brokerId, ledger_index: "validated" });
    pseudo = result.node?.Account;
  } catch {
    return [];
  }
  if (!pseudo) return [];
  const loans = await ownedObjects(pseudo, "loan");
  return loans.map((l) => ({ id: l.index, loan: l }));
}

/** A holder's MPToken for an issuance, or null when they have not opted in. */
export async function readMptoken(account, issuanceId) {
  if (!account || !issuanceId) return null;
  const client = await getClient();
  try {
    const { result } = await client.request({
      command: "ledger_entry", mptoken: { mpt_issuance_id: issuanceId, account }, ledger_index: "validated",
    });
    return result.node;
  } catch (e) {
    if (e?.data?.error === "entryNotFound") return null;
    throw e;
  }
}

/** Base-unit value of a transaction Amount field, whatever its shape. */
const amountValue = (a) => {
  if (a == null) return 0n;
  if (typeof a === "string") return BigInt(a);
  if (typeof a === "object" && a.value != null) return BigInt(String(a.value).split(".")[0]);
  return 0n;
};

/**
 * Net amount `account` has put into `vaultId`, derived from its transaction history so a
 * position reads the same on any device. Deposits add; withdrawals subtract what was
 * actually delivered (a withdrawal may be denominated in shares, so the delivered amount
 * is the reliable figure). Never negative.
 */
export async function netDeposited(account, vaultId) {
  if (!account || !vaultId) return 0n;
  const client = await getClient();
  let net = 0n;
  let marker;
  for (let i = 0; i < 20; i += 1) {
    let result;
    try {
      ({ result } = await client.request({
        command: "account_tx", account, limit: 200, ledger_index_min: -1, ledger_index_max: -1,
        ...(marker ? { marker } : {}),
      }));
    } catch {
      break;
    }
    for (const t of result.transactions || []) {
      const tx = t.tx_json || t.tx || {};
      if (tx.VaultID !== vaultId || t.meta?.TransactionResult !== "tesSUCCESS") continue;
      if (tx.TransactionType === "VaultDeposit") net += amountValue(tx.DeliverMax ?? tx.Amount);
      if (tx.TransactionType === "VaultWithdraw") net -= amountValue(t.meta?.delivered_amount ?? tx.Amount);
    }
    marker = result.marker;
    if (!marker) break;
  }
  return net > 0n ? net : 0n;
}

/**
 * Escrows `owner` has locked to `destination`, read from the ledger. Collateral has no
 * on-chain link to a loan, so the desk finds it by looking at what the borrower has
 * locked to the desk rather than relying on a sequence someone wrote down.
 */
export async function escrowsTo(owner, destination) {
  if (!owner || !destination) return [];
  const objs = await ownedObjects(owner, "escrow").catch(() => []);
  return objs
    .filter((e) => e.Destination === destination)
    // The object's Sequence is the creating transaction's sequence, which is exactly the
    // OfferSequence an EscrowFinish or EscrowCancel needs.
    .map((e) => ({ seq: e.Sequence, amount: e.Amount, cancelAfter: e.CancelAfter, node: e }));
}

/** Loans where `account` is the borrower, read from the ledger. Returns [{ id, loan }]. */
export async function borrowerLoans(account) {
  if (!account) return [];
  const loans = await ownedObjects(account, "loan").catch(() => []);
  return loans.map((l) => ({ id: l.index, loan: l }));
}

/** Minimum cover required now: DebtTotal * CoverRateMinimum / 100000 (BigInt). */
export function requiredCover(broker) {
  return (big(broker.DebtTotal) * big(broker.CoverRateMinimum)) / 100000n;
}
