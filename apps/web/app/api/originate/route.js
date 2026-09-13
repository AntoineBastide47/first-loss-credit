// The protocol operator co-signs a borrower's loan server-side. The borrower signs a
// LoanSet in their wallet (Counterparty = operator) and posts the signed blob here;
// the operator adds the CounterpartySignature and submits. The operator seed lives
// only in server env (OPERATOR_SEED), never in the browser.
//
// The operator's counterparty signature is the desk's credit decision, so this route
// MUST NOT sign an arbitrary blob. It decodes the LoanSet and re-runs the underwriting
// in lib/underwrite.js against the ledger as it stands now. The quote the borrower was
// shown is never trusted or stored: a signed loan is accepted only if it still fits the
// decision the desk reaches on its own.

import { Client, Wallet, decode, signLoanSetByCounterparty } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";
import { RATE_MAX, matchSchedule } from "../../../lib/credit";
import { underwrite } from "../../../lib/underwrite";

export const runtime = "nodejs";

function createdLoanId(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === "Loan") return c.LedgerIndex;
  }
  return null;
}

/**
 * Check the signed loan against the desk's decision. The schedule must be one the desk
 * currently offers, the rate must be at least the floor for THAT schedule (paying more is
 * the borrower's business, paying less is not), and the principal must fit the limit the
 * desk sets for it. Returns an error string, or null.
 */
function rejectLoan(tx, decision) {
  const option = matchSchedule(decision.options, tx);
  if (!option) return "That repayment schedule is not one the desk offers.";

  const rate = Number(tx.InterestRate);
  if (!Number.isInteger(rate) || rate > RATE_MAX) return "Interest rate is malformed.";
  if (rate < option.rate) {
    return `The desk's rate for a ${option.termLabel} loan is ${(option.rate / 1000).toFixed(2)}% APR, above what this loan carries. Refresh the quote and sign again.`;
  }

  let principal;
  try {
    principal = BigInt(tx.PrincipalRequested);
  } catch {
    return "Loan amount is malformed.";
  }
  if (principal <= 0n) return "Loan amount must be positive.";
  if (option.maxPrincipal === 0n) return option.reason;
  if (principal > option.maxPrincipal) return `That is above what the desk will lend you over ${option.termLabel}. ${option.reason}`;
  return null;
}

export async function POST(req) {
  const seed = process.env.OPERATOR_SEED;
  if (!seed) return Response.json({ error: "The lending desk is not configured." }, { status: 500 });

  let borrowerBlob;
  try {
    ({ borrowerBlob } = await req.json());
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (typeof borrowerBlob !== "string" || !borrowerBlob) {
    return Response.json({ error: "Missing signed loan." }, { status: 400 });
  }

  let loanTx;
  try {
    loanTx = decode(borrowerBlob);
  } catch {
    return Response.json({ error: "Signed loan is unreadable." }, { status: 400 });
  }

  const operator = Wallet.fromSeed(seed);
  if (loanTx?.TransactionType !== "LoanSet") {
    return Response.json({ error: "Not a loan request." }, { status: 422 });
  }
  if (loanTx.Counterparty !== operator.address) {
    return Response.json({ error: "Loan is not addressed to this desk." }, { status: 422 });
  }

  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();

    // Underwrite the borrower who actually signed, not whoever posted the blob.
    const decision = await underwrite(client, {
      brokerId: loanTx.LoanBrokerID,
      borrower: loanTx.Account,
      deskAddress: operator.address,
    });
    if (decision.error) return Response.json({ error: decision.error }, { status: 422 });

    const reason = rejectLoan(loanTx, decision);
    if (reason) return Response.json({ error: reason }, { status: 422 });

    const { tx_blob } = signLoanSetByCounterparty(operator, borrowerBlob);
    const res = await client.submitAndWait(tx_blob);
    const code = res.result.meta?.TransactionResult;
    return Response.json({
      code,
      hash: res.result.hash,
      loanId: code === "tesSUCCESS" ? createdLoanId(res.result.meta) : null,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    try {
      await client.disconnect();
    } catch {
      /* ignore */
    }
  }
}
