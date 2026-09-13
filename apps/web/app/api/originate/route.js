// The protocol operator co-signs a borrower's loan server-side. The borrower signs a
// LoanSet in their wallet (Counterparty = operator) and posts the signed blob here;
// the operator adds the CounterpartySignature and submits. The operator seed lives
// only in server env (OPERATOR_SEED), never in the browser.
//
// The operator's counterparty signature is the desk's underwriting consent, so this
// route MUST NOT sign an arbitrary blob: it decodes the LoanSet and rejects anything
// that is not this market's published product against this broker. Without the check,
// any client could originate a loan on borrower-chosen terms (e.g. 0% interest, the
// whole vault) and the operator would fund it.

import { Client, Wallet, decode, signLoanSetByCounterparty } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";
import { LOAN_TERMS } from "../../../lib/market";

export const runtime = "nodejs";

function createdLoanId(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === "Loan") return c.LedgerIndex;
  }
  return null;
}

/**
 * Check the loan's terms against the desk's published product. Only PrincipalRequested
 * varies, and it must be positive and within the vault's available liquidity. Returns an
 * error string, or null when the loan is acceptable.
 */
function rejectTerms(tx, availableBase) {
  if (Number(tx.InterestRate) !== LOAN_TERMS.InterestRate) return "Interest rate is not the desk's rate.";
  if (Number(tx.PaymentInterval) !== LOAN_TERMS.PaymentInterval) return "Payment schedule is not the desk's schedule.";
  if (Number(tx.PaymentTotal) !== LOAN_TERMS.PaymentTotal) return "Number of payments is not the desk's schedule.";
  if (Number(tx.GracePeriod) !== LOAN_TERMS.GracePeriod) return "Grace period is not the desk's schedule.";
  let principal;
  try {
    principal = BigInt(tx.PrincipalRequested);
  } catch {
    return "Loan amount is malformed.";
  }
  if (principal <= 0n) return "Loan amount must be positive.";
  if (principal > availableBase) return "Loan amount exceeds available liquidity.";
  return null;
}

/**
 * Resolve the market from the ledger using the broker the loan actually names. The market
 * list is not usable here: custom markets live in the browser's localStorage, so a
 * server-side lookup by id would silently fall back to a built-in market and reject every
 * loan against a vault created in the app. Reading the broker also proves the desk runs
 * that market before it agrees to co-sign. Returns { error } or { availableBase }.
 */
async function resolveMarket(client, brokerId, deskAddress) {
  let broker;
  try {
    const { result } = await client.request({ command: "ledger_entry", index: brokerId, ledger_index: "validated" });
    broker = result.node;
  } catch {
    return { error: "That market does not exist." };
  }
  if (broker?.LedgerEntryType !== "LoanBroker") return { error: "That market does not exist." };
  if (broker.Owner !== deskAddress) return { error: "This desk does not run that market." };
  const { result } = await client.request({ command: "vault_info", vault_id: broker.VaultID });
  return { availableBase: BigInt(result.vault?.AssetsAvailable ?? "0") };
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

    const market = await resolveMarket(client, loanTx.LoanBrokerID, operator.address);
    if (market.error) return Response.json({ error: market.error }, { status: 422 });

    const reason = rejectTerms(loanTx, market.availableBase);
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
