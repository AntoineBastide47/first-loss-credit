// Money formatting for the lending UI. On-ledger amounts are base-unit strings
// (drops for an XRP vault) and loan fields carry a high-precision fraction, e.g.
// PeriodicPayment = "20000038.05174906852". Never parse money to a JS number:
// format from strings and BigInt only.

/**
 * Place a decimal point `shift` digits from the right of `value`, which may itself
 * carry a fraction. Returns a plain decimal string with trailing zeros trimmed.
 * Example: formatScaled("20000038.05", 6) -> "20.00003805".
 */
export function formatScaled(value, shift) {
  const str = String(value ?? "0").trim();
  const neg = str.startsWith("-");
  const body = neg ? str.slice(1) : str;
  const [intPart = "0", fracPart = ""] = body.split(".");
  // Concatenate all digits; the point sits (fracPart.length + shift) from the right.
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, "");
  const pointFromRight = fracPart.length + shift;
  const padded = digits.padStart(pointFromRight + 1, "0");
  const cut = padded.length - pointFromRight;
  let whole = padded.slice(0, cut);
  let frac = padded.slice(cut).replace(/0+$/, "");
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  const sign = neg && /[1-9]/.test(digits) ? "-" : "";
  return sign + (frac ? `${whole}.${frac}` : whole);
}

/** Base-unit drops string -> XRP decimal string (6 base-unit digits). */
export function formatDrops(drops) {
  return formatScaled(drops, 6);
}

/** Group the integer part of a decimal string with thousands separators. */
export function groupThousands(decStr) {
  const [whole, frac] = String(decStr).split(".");
  const neg = whole.startsWith("-");
  const digits = neg ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + (frac ? `.${frac}` : "");
}

/**
 * Round a high-precision loan figure UP to a whole base unit (ceil to integer).
 * Loan fields are already base-unit denominated, so this is not a rescale. Returns
 * an integer base-unit string. (Mirrors impl/lib roundUpToAssetUnit.)
 */
export function roundUpToAssetUnit(value) {
  const str = String(value ?? "0").trim();
  const neg = str.startsWith("-");
  const body = neg ? str.slice(1) : str;
  const [intPart = "0", fracPart = ""] = body.split(".");
  let base = BigInt(intPart || "0");
  if (!neg && /[1-9]/.test(fracPart)) base += 1n;
  return (neg ? "-" : "") + base.toString();
}

/**
 * Decimal string for a ratio num/den (BigInt inputs or base-unit strings), with
 * `dp` fraction digits. Returns null when the denominator is 0 (ratio undefined).
 */
export function ratioString(num, den, dp = 6) {
  const n = BigInt(num ?? "0");
  const d = BigInt(den ?? "0");
  if (d === 0n) return null;
  const scale = 10n ** BigInt(dp);
  const scaled = (n * scale) / d; // truncates; a display figure, not money
  return formatScaled(scaled.toString(), dp);
}

/**
 * Rate as a percent string. Cover rates use fullScale 100000 (100% = 100000);
 * ManagementFeeRate uses fullScale 10000. Returns e.g. "50" for 50%.
 */
export function formatRatePct(rate, fullScale = 100000, dp = 3) {
  return ratioString(BigInt(rate ?? "0") * 100n, fullScale, dp);
}

/** Shorten a hash or ledger id for display: first+last `n` chars. */
export function shortId(id, n = 6) {
  const s = String(id ?? "");
  return s.length > 2 * n + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}
