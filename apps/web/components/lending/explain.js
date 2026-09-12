"use client";

// Plain-language cause for XRPL engine result codes, injected into TxButton's
// `explain` prop so every write shows a human reason next to the raw code. Codes and
// meanings are the ones verified across the lending flows.
const CAUSES = {
  tesSUCCESS: null,
  tecNO_AUTH:
    "Not authorized: the account is not a domain member (no accepted matching credential), or an MPT holder is not yet issuer-authorized.",
  tecNO_PERMISSION:
    "Not permitted: e.g. not the vault or broker owner, an escrow finish before FinishAfter, or a build/vault-kind policy.",
  tecCRYPTOCONDITION_ERROR: "Wrong fulfillment for the escrow's crypto-condition.",
  tecEXPIRED:
    "Past a time window: an overdue loan payment needs the late-payment flag, or a finish is past CancelAfter.",
  tecTOO_SOON:
    "Before a time window: impair/default before the schedule, or a closed-vault action at the wrong point in the vault lifecycle.",
  tecINSUFFICIENT_PAYMENT:
    "The paid amount is below the required amount. Round the periodic payment UP to a whole base unit (MPT vaults do not tolerate the fractional shortfall XRP does).",
  tecINSUFFICIENT_FUNDS:
    "A cover-ratio or liquidity invariant, not a raw balance shortfall (funds may be ample).",
  tecLIMIT_EXCEEDED: "Over a cap: AssetsMaximum on the vault or DebtMaximum on the broker.",
  tecKILLED:
    "Could not complete: tfLoanFullPayment on the final payment, or paying an already-settled loan.",
  temMALFORMED:
    "Malformed transaction: e.g. a conditioned escrow finish with no Fulfillment, or a bad amount shape.",
  temBAD_SIGNER:
    "Signature problem: e.g. a LoanSet Counterparty without a valid CounterpartySignature.",
};

/** (txType, code) -> one-line cause, or null when the code is success/unknown. */
export function explain(_txType, code) {
  if (!code || code === "tesSUCCESS") return null;
  return CAUSES[code] || null;
}
