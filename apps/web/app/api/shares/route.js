// Settlement for the secondary market in vault shares.
//
// A seller lists by escrowing shares to the desk under a condition only the desk can open,
// with the asking price in the escrow's DestinationTag. A buyer pays the SELLER directly,
// tagging the payment with the listing's sequence, and then asks the desk to settle. The
// desk verifies that payment on the ledger before it releases anything, so it never takes
// the buyer's money and never decides the price.
//
//   op "condition" { seller }                     -> { condition }  (goes on EscrowCreate)
//   op "fill"      { vaultId, owner, seq, buyer, paymentHash } -> { code, hash }
//
// The release secret is derived from the operator seed and the seller's address, so
// nothing is persisted. It is derived in a different namespace from the collateral secret
// in /api/collateral: a collateral escrow must never be openable as if it were a listing.
//
// The operator seed lives only in server env (OPERATOR_SEED), never in the browser.

import { createHash, createHmac } from "node:crypto";
import { Client, Wallet } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";

export const runtime = "nodejs";

/** Deterministic PREIMAGE-SHA-256 condition/fulfillment for a seller's listings. */
function listingSecret(seed, seller) {
  const key = createHash("sha256").update(`flc-share-listing-v1:${seed}`).digest();
  const preimage = createHmac("sha256", key).update(seller).digest();
  const hash = createHash("sha256").update(preimage).digest("hex").toUpperCase();
  return {
    condition: `A0258020${hash}810120`,
    fulfillment: `A0228020${preimage.toString("hex").toUpperCase()}`,
  };
}

const isHash = (v) => /^[0-9A-Fa-f]{64}$/.test(v || "");

async function send(client, wallet, tx) {
  const prepared = await client.autofill(tx);
  const res = await client.submitAndWait(wallet.sign(prepared).tx_blob);
  return { code: res.result.meta?.TransactionResult, hash: res.result.hash };
}

/**
 * Confirm the buyer really paid the seller for this listing. Everything checked here comes
 * off the ledger; nothing is taken from the request except which transaction to look at.
 * Returns an error string, or null.
 */
async function verifyPayment(client, { paymentHash, buyer, seller, price, asset, seq }) {
  let result;
  try {
    ({ result } = await client.request({ command: "tx", transaction: paymentHash }));
  } catch {
    return "That payment was not found on the ledger.";
  }
  if (!result.validated || result.meta?.TransactionResult !== "tesSUCCESS") return "That payment did not settle.";
  const tx = result.tx_json || result;
  if (tx.TransactionType !== "Payment") return "That transaction is not a payment.";
  if (tx.Account !== buyer) return "That payment was not sent by you.";
  if (tx.Destination !== seller) return "That payment did not go to the seller.";
  // The tag binds one payment to one listing, so a single payment cannot settle two.
  if (Number(tx.DestinationTag ?? 0) !== Number(seq)) return "That payment is not tagged for this listing.";
  const paid = result.meta?.delivered_amount ?? tx.DeliverMax ?? tx.Amount;
  const want = asset.kind === "MPT" ? { mpt_issuance_id: asset.issuanceId, value: String(price) } : String(price);
  const ok =
    typeof want === "string"
      ? String(paid) === want
      : paid?.mpt_issuance_id === want.mpt_issuance_id && String(paid?.value) === want.value;
  return ok ? null : "That payment is not the asking price.";
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
    if (!body.seller) return Response.json({ error: "Missing the seller." }, { status: 400 });
    return Response.json({ condition: listingSecret(seed, body.seller).condition });
  }

  if (body?.op !== "fill") return Response.json({ error: "Unknown operation." }, { status: 400 });

  const { vaultId, owner, seq, buyer, paymentHash } = body;
  if (!isHash(vaultId)) return Response.json({ error: "Missing the market." }, { status: 400 });
  if (!owner || seq == null || !buyer) return Response.json({ error: "Missing the listing." }, { status: 400 });
  if (!isHash(paymentHash)) return Response.json({ error: "Missing the payment." }, { status: 400 });

  const desk = Wallet.fromSeed(seed);
  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();

    // The vault says which MPT is a share of it and what the shares are priced in. Reading
    // it from the ledger means the request cannot name a token of its own choosing.
    const { result: vr } = await client.request({ command: "vault_info", vault_id: vaultId });
    const vault = vr.vault;
    if (!vault) return Response.json({ error: "That market does not exist." }, { status: 422 });
    if (vault.Owner !== desk.address) return Response.json({ error: "This desk does not run that market." }, { status: 422 });
    const shareMptId = vault.ShareMPTID;
    const mpt = vault.Asset?.mpt_issuance_id;
    const asset = mpt ? { kind: "MPT", issuanceId: mpt } : { kind: "XRP" };

    let escrow;
    try {
      const { result } = await client.request({
        command: "ledger_entry", escrow: { owner, seq: Number(seq) }, ledger_index: "validated",
      });
      escrow = result.node;
    } catch {
      return Response.json({ error: "That listing is gone." }, { status: 422 });
    }
    if (escrow?.Destination !== desk.address) return Response.json({ error: "That listing is not offered to this desk." }, { status: 422 });
    if (escrow.Amount?.mpt_issuance_id !== shareMptId) {
      return Response.json({ error: "That escrow is not a share listing for this market." }, { status: 422 });
    }
    const price = Number(escrow.DestinationTag ?? 0);
    if (!price) return Response.json({ error: "That listing has no asking price." }, { status: 422 });

    // The buyer must already hold the share token, or the desk would finish the escrow and
    // then be unable to pass the shares on. For a gated vault this is also where a buyer
    // outside the domain is turned away, before any value moves.
    try {
      await client.request({
        command: "ledger_entry", mptoken: { mpt_issuance_id: shareMptId, account: buyer }, ledger_index: "validated",
      });
    } catch {
      return Response.json({ error: "Opt in to this market's shares before buying." }, { status: 422 });
    }

    const bad = await verifyPayment(client, { paymentHash, buyer, seller: owner, price, asset, seq });
    if (bad) return Response.json({ error: bad }, { status: 422 });

    // The desk must hold the share token to receive it. Already opted in is fine.
    try {
      await send(client, desk, { TransactionType: "MPTokenAuthorize", Account: desk.address, MPTokenIssuanceID: shareMptId });
    } catch {
      /* already authorized */
    }

    const { condition, fulfillment } = listingSecret(seed, owner);
    const finish = await send(client, desk, {
      TransactionType: "EscrowFinish", Account: desk.address, Owner: owner,
      OfferSequence: Number(seq), Condition: condition, Fulfillment: fulfillment,
    });
    if (finish.code !== "tesSUCCESS") {
      return Response.json({ error: `The listing could not be released (${finish.code}).` }, { status: 422 });
    }

    const shares = String(escrow.Amount.value).split(".")[0];
    const hand = await send(client, desk, {
      TransactionType: "Payment", Account: desk.address, Destination: buyer,
      Amount: { mpt_issuance_id: shareMptId, value: shares },
    });
    return Response.json({ code: hand.code, hash: hand.hash, shares });
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
