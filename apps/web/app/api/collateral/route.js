// Collateral escrow support. Collateral is locked by the borrower in an escrow whose
// crypto-condition only the desk can open, so the desk (not the borrower) controls the
// release. The release secret is DERIVED from the operator seed and the borrower
// address, so nothing is persisted: the same borrower always maps to the same
// condition, and the server can recompute the fulfillment to claim on default.
//
//   op "condition" { borrower }        -> { condition }   (borrower puts it on EscrowCreate)
//   op "claim"     { owner, seq, tokenId } -> { code, hash }  (desk finishes the escrow)
//
// The operator seed lives only in server env (OPERATOR_SEED), never in the browser.

import { createHash, createHmac } from "node:crypto";
import { Client, Wallet } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";

export const runtime = "nodejs";

/** Deterministic PREIMAGE-SHA-256 condition/fulfillment for a borrower. */
function collateralSecret(seed, borrower) {
  const key = createHash("sha256").update(`flc-collateral-v1:${seed}`).digest();
  const preimage = createHmac("sha256", key).update(borrower).digest(); // 32 bytes
  const hash = createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return {
    condition: `A0258020${hash}810120`,
    fulfillment: `A0228020${preimage.toString("hex").toUpperCase()}`,
  };
}

export async function POST(req) {
  const seed = process.env.OPERATOR_SEED;
  if (!seed) return Response.json({ error: "The lending desk is not configured." }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  if (body?.op === "condition") {
    if (!body.borrower) return Response.json({ error: "Missing borrower." }, { status: 400 });
    return Response.json({ condition: collateralSecret(seed, body.borrower).condition });
  }

  if (body?.op === "claim") {
    const { owner, seq, tokenId } = body;
    if (!owner || seq == null) return Response.json({ error: "Missing escrow reference." }, { status: 400 });
    const operator = Wallet.fromSeed(seed);
    const { condition, fulfillment } = collateralSecret(seed, owner);
    const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
    try {
      await client.connect();
      // The desk must hold the collateral token to receive it. Opt in first; ignore
      // the result (already opted in is fine), then finish the escrow.
      if (tokenId) {
        try {
          const auth = await client.autofill({ TransactionType: "MPTokenAuthorize", Account: operator.address, MPTokenIssuanceID: tokenId });
          await client.submitAndWait(operator.sign(auth).tx_blob);
        } catch {
          /* already authorized or not required */
        }
      }
      const finish = await client.autofill({
        TransactionType: "EscrowFinish",
        Account: operator.address,
        Owner: owner,
        OfferSequence: Number(seq),
        Condition: condition,
        Fulfillment: fulfillment,
      });
      const res = await client.submitAndWait(operator.sign(finish).tx_blob);
      return Response.json({ code: res.result.meta?.TransactionResult, hash: res.result.hash });
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

  return Response.json({ error: "Unknown operation." }, { status: 400 });
}
