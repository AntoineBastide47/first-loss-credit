"use client";

// Product-facing helpers over the single market. Everything here is in human XRP;
// ledger ids and base units stay out of the UI.

import { readVault, readBroker, shareBalance, redeemableAssets } from "./lending-read";
import { MARKET } from "./market";

export const marketVault = () => readVault(MARKET.vaultId);
export const marketBroker = () => readBroker(MARKET.brokerId);
export const myShares = (address) => (address ? shareBalance(address, MARKET.shareMptId) : Promise.resolve("0"));

const big = (v) => BigInt(v ?? "0");

/** Fraction of vault assets currently lent out, 0..1 (Number, for a bar/label). */
export function utilisation(vault) {
  const total = big(vault?.AssetsTotal);
  if (total === 0n) return 0;
  return Number(((total - big(vault?.AssetsAvailable)) * 10000n) / total) / 10000;
}

// Cost basis (net XRP deposited), kept per address in the browser. Not ledger state.
const basisKey = (a) => `flc:earn-basis:${MARKET.vaultId}:${a}`;
export function loadBasis(a) {
  try {
    return BigInt(window.localStorage.getItem(basisKey(a)) || "0");
  } catch {
    return 0n;
  }
}
export function saveBasis(a, v) {
  try {
    window.localStorage.setItem(basisKey(a), v.toString());
  } catch {
    /* best effort */
  }
}

// The borrower's active loan id, remembered per address.
const loanKey = (a) => `flc:my-loan:${a}`;
export function loadMyLoan(a) {
  try {
    return window.localStorage.getItem(loanKey(a)) || null;
  } catch {
    return null;
  }
}
export function saveMyLoan(a, id) {
  try {
    if (id) window.localStorage.setItem(loanKey(a), id);
    else window.localStorage.removeItem(loanKey(a));
  } catch {
    /* best effort */
  }
}

// Loans this browser has seen (originated through the app), plus the market's seed
// loan, so the desk has a book to manage without a "list all loans" query.
const KNOWN_LOANS = "flc:known-loans";
export function knownLoans() {
  let ids = [];
  try {
    ids = JSON.parse(window.localStorage.getItem(KNOWN_LOANS) || "[]");
  } catch {
    ids = [];
  }
  return Array.from(new Set([MARKET.seedLoanId, ...ids].filter(Boolean)));
}
export function addKnownLoan(id) {
  if (!id) return;
  try {
    const set = new Set(JSON.parse(window.localStorage.getItem(KNOWN_LOANS) || "[]"));
    set.add(id);
    window.localStorage.setItem(KNOWN_LOANS, JSON.stringify([...set]));
  } catch {
    /* best effort */
  }
}

export { redeemableAssets };
