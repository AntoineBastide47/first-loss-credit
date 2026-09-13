// What the desk will lend this borrower, and at what rate.
//
// The borrow screen asks for this before the borrower types an amount, so the limit and
// the price are visible up front instead of arriving as a rejection after they have
// signed. /api/originate re-derives the same decision from the ledger when the signed
// loan comes back, so this quote is a preview, never a promise the server has to store.
//
// Read-only: it needs the desk's address to know which markets are its own, not its key.

import { Client, Wallet } from "xrpl";
import { DEFAULT_NETWORK } from "../../../lib/networks";
import { underwrite, quoteJson } from "../../../lib/underwrite";

export const runtime = "nodejs";

export async function POST(req) {
  const seed = process.env.OPERATOR_SEED;
  if (!seed) return Response.json({ error: "The lending desk is not configured." }, { status: 500 });

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Bad request." }, { status: 400 });
  }

  const desk = Wallet.fromSeed(seed).address;
  const client = new Client(DEFAULT_NETWORK.wss, { connectionTimeout: 20000 });
  try {
    await client.connect();
    const decision = await underwrite(client, {
      brokerId: body?.brokerId,
      borrower: body?.borrower,
      deskAddress: desk,
    });
    if (decision.error) return Response.json({ error: decision.error }, { status: 422 });
    return Response.json(quoteJson(decision));
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
