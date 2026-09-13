// Asset abstraction so every lender/loan screen works on an XRP vault or an MPT vault
// without special-casing. A market carries an `asset` descriptor:
//   { kind: "XRP" }                                  -> base unit = drop, scale 6
//   { kind: "MPT", issuanceId, scale, symbol }       -> base unit = 10^-scale token
//
// On-ledger amounts and balances (AssetsTotal, PrincipalOutstanding, MPTAmount, ...) are
// always integer base-unit strings for a given asset; loan accounting fields carry a
// high-precision fraction. Money is never a JS number: format and parse from strings.

import { formatScaled, groupThousands, trimFraction } from "./format";

/** Base-unit precision: XRP is fixed at 6 (drops); an MPT uses its AssetScale. */
export function assetScale(asset) {
  return asset?.kind === "MPT" ? Number(asset.scale ?? 0) : 6;
}

/** Ticker shown next to amounts. */
export function assetSymbol(asset) {
  return asset?.kind === "MPT" ? asset.symbol || "units" : "XRP";
}

/** Base-unit string -> grouped human decimal (e.g. "1500000" XRP -> "1.5"). */
export function formatAmount(asset, baseUnits) {
  return groupThousands(formatScaled(String(baseUnits ?? "0"), assetScale(asset)));
}

/**
 * The same amount at display precision, for headline figures that must fit a narrow
 * column. Cut, never rounded up, so it never overstates a balance. Pair it with the exact
 * value in a title attribute wherever the precise number still matters.
 */
export function formatAmountShort(asset, baseUnits, dp = 4) {
  const full = formatAmount(asset, baseUnits);
  const short = trimFraction(full, dp);
  // A dust balance must not be reported as nothing, so keep the exact figure instead.
  return /[1-9]/.test(short) || !/[1-9]/.test(full) ? short : full;
}

/**
 * Human decimal string -> integer base-unit string for this asset. Throws on a
 * malformed value or more fraction digits than the asset's scale.
 */
export function toBaseUnits(asset, human) {
  const str = String(human ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw new Error("Enter a number.");
  const scale = assetScale(asset);
  const [intPart, fracPart = ""] = str.split(".");
  if (fracPart.length > scale) throw new Error(`At most ${scale} decimal places.`);
  const digits = (intPart + fracPart.padEnd(scale, "0")).replace(/^0+(?=\d)/, "");
  return BigInt(digits).toString();
}

/** True when `human` parses to a strictly positive base-unit amount. */
export function isPositiveAmount(asset, human) {
  try {
    return BigInt(toBaseUnits(asset, human)) > 0n;
  } catch {
    return false;
  }
}

/**
 * Transaction Amount for this asset's value: an XRP drops string, or an MPT object
 * { mpt_issuance_id, value }. Used for VaultDeposit/Withdraw asset amounts, LoanPay,
 * cover deposit/withdraw, and PrincipalRequested is the plain base-unit string.
 */
export function assetAmount(asset, baseUnits) {
  const value = String(baseUnits);
  return asset?.kind === "MPT" ? { mpt_issuance_id: asset.issuanceId, value } : value;
}

/** Withdraw-by-shares Amount: shares are always an MPT (the vault share issuance). */
export function shareAmount(shareMptId, shares) {
  return { mpt_issuance_id: shareMptId, value: String(shares) };
}

/** Derive an asset descriptor from a vault_info object (fallback when config lacks it). */
export function assetOfVault(vault, scale, symbol) {
  const a = vault?.Asset;
  if (a && a.mpt_issuance_id) return { kind: "MPT", issuanceId: a.mpt_issuance_id, scale: scale ?? 0, symbol };
  return { kind: "XRP" };
}
