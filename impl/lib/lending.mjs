// Shared, phase-agnostic building blocks for the lending flow.
//
// These compose the generic primitives in ./index.mjs into the protocol objects a
// lending scenario needs: a vault, a deposit, a broker, cover, and a dual-signed
// loan. They belong to no phase. A phase imports them like any library; it never
// imports another phase, and nothing here depends on any phase.

import { VaultWithdrawalPolicy, signLoanSetByCounterparty } from "xrpl";
import { submitAndWait, readVault, explorer } from "./index.mjs";

const XRP = { currency: "XRP" };

// ---- metadata / assertion utilities ----

/** LedgerIndex of the first created object of `entryType` in tx metadata. */
export function createdIndex(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.LedgerIndex;
  }
  throw new Error(`no created ${entryType} in metadata`);
}

/** NewFields of the first created object of `entryType` in tx metadata. */
export function createdFields(meta, entryType) {
  for (const n of meta.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === entryType) return c.NewFields;
  }
  throw new Error(`no created ${entryType} in metadata`);
}

/** Signed XRP balance change of `account` in this tx (after - before), in drops (BigInt). */
export function balanceChange(meta, account) {
  for (const n of meta.AffectedNodes || []) {
    const m = n.ModifiedNode || n.CreatedNode;
    const ff = m?.FinalFields || m?.NewFields;
    if (m?.LedgerEntryType === "AccountRoot" && ff?.Account === account) {
      const before = BigInt(m.PreviousFields?.Balance ?? ff.Balance);
      return BigInt(ff.Balance) - before;
    }
  }
  return 0n;
}

/** BigInt helper that treats an absent field (XRPL omits zero values) as 0. */
export const big = (v) => BigInt(v ?? "0");

/** Throw on a false condition; log the check otherwise. */
export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  assert ok: ${msg}`);
}

/** A run log that records explorer links and prints each success line. */
export function makeRecorder() {
  const links = [];
  const record = (label, hash) => {
    links.push(`  ${label}: ${explorer(hash)}`);
    console.log(`✓ ${label}  ${hash}`);
  };
  const printLinks = () => console.log("\nExplorer links:\n" + links.join("\n"));
  return { links, record, printLinks };
}

/** An account's balance of the vault share MPT issuance (string drops-equivalent). */
export async function shareBalance(client, holder, shareMptId) {
  const { result } = await client.request({
    command: "account_objects", account: holder, type: "mptoken",
  });
  const tok = (result.account_objects || []).find((o) => o.MPTokenIssuanceID === shareMptId);
  return tok ? tok.MPTAmount ?? "0" : "0";
}

// ---- protocol object builders ----

/**
 * Create a Single Asset Vault owned by `owner`.
 * opts: { asset = XRP, assetsMaximum, domainId, flags, withdrawalPolicy }.
 * Returns { hash, meta, vaultId, shareMptId, vault }.
 */
export async function createVault(client, owner, opts = {}) {
  const tx = {
    TransactionType: "VaultCreate",
    Account: owner.address,
    Asset: opts.asset ?? XRP,
    WithdrawalPolicy: opts.withdrawalPolicy ?? VaultWithdrawalPolicy.vaultStrategyFirstComeFirstServe,
  };
  if (opts.assetsMaximum) tx.AssetsMaximum = opts.assetsMaximum;
  if (opts.domainId) tx.DomainID = opts.domainId;
  if (opts.flags) tx.Flags = opts.flags;
  const res = await submitAndWait(client, tx, owner);
  const vaultId = createdIndex(res.meta, "Vault");
  const vault = await readVault(client, vaultId);
  return { hash: res.hash, meta: res.meta, vaultId, shareMptId: vault.ShareMPTID, vault };
}

/** Deposit `amount` into `vaultId` from `lender`. Returns { hash, meta }. */
export async function vaultDeposit(client, lender, vaultId, amount) {
  return submitAndWait(client, {
    TransactionType: "VaultDeposit", Account: lender.address, VaultID: vaultId, Amount: amount,
  }, lender);
}

/**
 * Create a loan broker on `vaultId` owned by `owner` (must be the vault owner).
 * opts: { managementFeeRate = 0, debtMaximum = "1000000000",
 *         coverRateMinimum = 10000, coverRateLiquidation = 20000 }.
 * Returns { hash, meta, brokerId }.
 */
export async function createBroker(client, owner, vaultId, opts = {}) {
  const res = await submitAndWait(client, {
    TransactionType: "LoanBrokerSet", Account: owner.address, VaultID: vaultId,
    ManagementFeeRate: opts.managementFeeRate ?? 0,
    DebtMaximum: opts.debtMaximum ?? "1000000000",
    CoverRateMinimum: opts.coverRateMinimum ?? 10000,
    CoverRateLiquidation: opts.coverRateLiquidation ?? 20000,
  }, owner);
  return { hash: res.hash, meta: res.meta, brokerId: createdIndex(res.meta, "LoanBroker") };
}

/** Deposit first-loss `cover` into `brokerId` from `owner`. Returns { hash, meta }. */
export async function depositCover(client, owner, brokerId, cover) {
  return submitAndWait(client, {
    TransactionType: "LoanBrokerCoverDeposit", Account: owner.address, LoanBrokerID: brokerId, Amount: cover,
  }, owner);
}

const DEFAULT_LOAN_TERMS = {
  InterestRate: 100000, PaymentInterval: 60, PaymentTotal: 1, GracePeriod: 60,
};

/**
 * Build a dual-signed LoanSet blob: `borrower` (Account) signs first, `owner`
 * (Counterparty / broker owner) adds the CounterpartySignature. Does NOT submit.
 * Returns the tx_blob (use for negative controls where the LoanSet must fail).
 *
 * Uses xrpl.js signLoanSetByCounterparty (fixed in 5.2.0-beta.1 to sign the
 * counterparty signature with the CounterpartyTxSign prefix).
 */
export async function signedLoanSet(client, { borrower, owner, brokerId, principal, terms = {} }) {
  const tx = await client.autofill({
    TransactionType: "LoanSet", Account: borrower.address, Counterparty: owner.address,
    LoanBrokerID: brokerId, PrincipalRequested: principal, ...DEFAULT_LOAN_TERMS, ...terms,
  });
  return signLoanSetByCounterparty(owner, borrower.sign(tx).tx_blob).tx_blob;
}

/**
 * Originate a loan (build, dual-sign, submit, wait). Throws on non-tesSUCCESS.
 * Returns { hash, meta, loanId }.
 */
export async function originateLoan(client, args) {
  const blob = await signedLoanSet(client, args);
  const res = await client.submitAndWait(blob);
  const code = res.result.meta?.TransactionResult;
  if (code !== "tesSUCCESS") throw new Error(`LoanSet failed: ${code}`);
  return { hash: res.result.hash, meta: res.result.meta, loanId: createdIndex(res.result.meta, "Loan") };
}
