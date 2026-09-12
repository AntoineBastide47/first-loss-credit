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
import { getMarket } from "../../../lib/market";

export const runtime = "nodejs";

function createdLoanId(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === "Loan") return c.LedgerIndex;
  }
  return null;
}

/**
 * Reject a decoded LoanSet that is not this market's product. Terms must equal the
 * published loanTerms exactly; only PrincipalRequested varies, and it must be a
 * positive drops amount within the vault's available liquidity. Returns an error
 * string, or null when the loan is acceptable.
 */
function rejectLoan(tx, market, availableBase) {
  const t = market.loanTerms;
  if (tx?.TransactionType !== "LoanSet") return "Not a loan request.";
  if (tx.Counterparty !== market.operator) return "Loan is not addressed to this desk.";
  if (tx.LoanBrokerID !== market.brokerId) return "Loan is for a different market.";
  if (Number(tx.InterestRate) !== t.InterestRate) return "Interest rate is not the desk's rate.";
  if (Number(tx.PaymentInterval) !== t.PaymentInterval) return "Payment schedule is not the desk's schedule.";
  if (Number(tx.PaymentTotal) !== t.PaymentTotal) return "Number of payments is not the desk's schedule.";
  if (Number(tx.GracePeriod) !== t.GracePeriod) return "Grace period is not the desk's schedule.";
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

async function availableLiquidity(client, market) {
  const { result } = await client.request({ command: "vault_info", vault_id: market.vaultId });
  return BigInt(result.vault?.AssetsAvailable ?? "0");
}

export async function POST(req) {
  const seed = process.env.OPERATOR_SEED;
  if (!seed) return Response.json({ error: "The lending desk is not configured." }, { status: 500 });

  let borrowerBlob, marketId;
  try {
    ({ borrowerBlob, marketId } = await req.json());
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }
  if (typeof borrowerBlob !== "string" || !borrowerBlob) {
    return Response.json({ error: "Missing signed loan." }, { status: 400 });
  }
  const market = getMarket(marketId);

  let loanTx;
  try {
    loanTx = decode(borrowerBlob);
  } catch {
    return Response.json({ error: "Signed loan is unreadable." }, { status: 400 });
  }

  const operator = Wallet.fromSeed(seed);
  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();

    const reason = rejectLoan(loanTx, market, await availableLiquidity(client, market));
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
