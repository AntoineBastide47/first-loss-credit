"use client";

// The secondary market for vault shares.
//
// A lender's normal exit is VaultWithdraw, which needs idle assets. Once the pool is lent
// out, and especially once loans run for months, there is nothing idle to redeem and the
// only way out is to sell the position to someone else. Vault shares are an MPT
// (ShareMPTID) and are transferable unless the vault was created with
// tfVaultShareNonTransferable, so they can change hands.
//
// The ledger has no order book for them: OfferCreate's TakerGets/TakerPays are typed
// `Amount`, which does not include MPTs, so the native DEX cannot quote shares. What does
// work is Payment and EscrowCreate, both of which accept an MPT amount. So a listing is an
// escrow of shares addressed to the desk, and the book is simply every such escrow in the
// desk's directory. Nothing is stored off-ledger: cancel the escrow and the listing is
// gone, fill it and it is consumed.
//
// The asking price rides in the escrow's DestinationTag, in base units of the market's
// asset. That field is a UInt32, so a listing cannot ask for more than MAX_PRICE base
// units (4294.967295 XRP, or 42,949,672.95 of a 2-decimal token).

import { escrowsInto, redeemableAssets } from "./lending-read";
import { baseUnits } from "./format";

/** DestinationTag is a UInt32, and it carries the asking price. */
export const MAX_PRICE = 4294967295;

/** How long a listing stays open. It cannot be cancelled before it expires. */
export const LISTING_WINDOWS = [
  { id: "1h", label: "1 hour", seconds: 3600 },
  { id: "1d", label: "1 day", seconds: 86400 },
  { id: "7d", label: "7 days", seconds: 7 * 86400 },
];

const RIPPLE_EPOCH = 946684800;
export const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

/**
 * Open listings for a market's shares. A listing is an escrow whose amount is this
 * vault's share MPT and whose DestinationTag names a price; anything else in the desk's
 * directory (collateral, for instance) is not a listing and is ignored.
 */
export async function shareListings(market) {
  const escrows = await escrowsInto(market.operator);
  return escrows
    .filter((e) => e.amount?.mpt_issuance_id === market.shareMptId && e.tag > 0)
    .map((e) => ({
      seller: e.owner,
      seq: e.seq,
      shares: baseUnits(e.amount.value).toString(),
      price: String(e.tag),
      cancelAfter: e.cancelAfter ?? null,
      finishAfter: e.finishAfter ?? null,
    }))
    .sort((a, b) => Number(a.seq) - Number(b.seq));
}

/** What a listing's shares would redeem for if the pool had the liquidity (BigInt). */
export const listingValue = (vault, listing) =>
  vault ? redeemableAssets(vault, BigInt(listing.shares)) : 0n;

/**
 * Asking price against redemption value, in basis points. Negative is a discount, which is
 * what a seller who needs out before the loans mature should expect to pay.
 */
export function listingSpreadBps(vault, listing) {
  const value = listingValue(vault, listing);
  if (value === 0n) return null;
  return Number(((BigInt(listing.price) - value) * 10000n) / value);
}

/** A listing is fillable once its FinishAfter has passed and before it expires. */
export const isOpen = (listing, now = rippleNow()) =>
  (listing.finishAfter == null || now > Number(listing.finishAfter)) &&
  (listing.cancelAfter == null || now < Number(listing.cancelAfter));
