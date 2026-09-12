// The protocol operator co-signs a borrower's loan server-side. The borrower signs a
// LoanSet in their wallet (Counterparty = operator) and posts the signed blob here;
// the operator adds the CounterpartySignature and submits. The operator seed lives
// only in server env (OPERATOR_SEED), never in the browser.

import { Client, Wallet, signLoanSetByCounterparty } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";

export const runtime = "nodejs";

function createdLoanId(meta) {
  for (const n of meta?.AffectedNodes || []) {
    const c = n.CreatedNode;
    if (c && c.LedgerEntryType === "Loan") return c.LedgerIndex;
  }
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
  if (!borrowerBlob) return Response.json({ error: "Missing signed loan." }, { status: 400 });

  const operator = Wallet.fromSeed(seed);
  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();
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
