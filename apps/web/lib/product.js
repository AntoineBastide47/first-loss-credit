"use client";

// Product-facing helpers over a market. A market is asset-generic (XRP or MPT): see
// lib/asset.js for how amounts are formatted and parsed. Ledger ids stay out of the UI.

import { readVault, readBroker, shareBalance, redeemableAssets } from "./lending-read";

export const marketVault = (market) => readVault(market.vaultId);
export const marketBroker = (market) => readBroker(market.brokerId);
export const myShares = (market, address) =>
  address ? shareBalance(address, market.shareMptId) : Promise.resolve("0");

const big = (v) => BigInt(v ?? "0");

/** Fraction of vault assets currently lent out, 0..1 (Number, for a bar/label). */
export function utilisation(vault) {
  const total = big(vault?.AssetsTotal);
  if (total === 0n) return 0;
  return Number(((total - big(vault?.AssetsAvailable)) * 10000n) / total) / 10000;
}

// The borrower's active loan id in a market, remembered per address.
const loanKey = (market, a) => `flc:my-loan:${market.id}:${a}`;
export function loadMyLoan(market, a) {
  try {
    return window.localStorage.getItem(loanKey(market, a)) || null;
  } catch {
    return null;
  }
}
export function saveMyLoan(market, a, id) {
  try {
    if (id) window.localStorage.setItem(loanKey(market, a), id);
    else window.localStorage.removeItem(loanKey(market, a));
  } catch {
    /* best effort */
  }
}

export { redeemableAssets };
