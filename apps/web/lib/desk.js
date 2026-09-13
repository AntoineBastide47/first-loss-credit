"use client";

// Calls to the desk's server routes. The desk owns the vault and broker objects for
// markets created in the app, so anything only an owner may sign goes through here.
// Actions that move value are authorised from ledger state (for example cover is always
// returned to the creator recorded on the vault), never from what the caller claims.

/** POST one operation to /api/vault. Throws with the server's reason on failure. */
export async function deskOp(body) {
  const r = await fetch("/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error(d.error);
  if (d.code && d.code !== "tesSUCCESS") throw new Error(`The ledger rejected it (${d.code}).`);
  return d;
}

/** POST one operation to /api/collateral. Throws with the server's reason on failure. */
export async function collateralOp(body) {
  const r = await fetch("/api/collateral", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (d.error) throw new Error(d.error);
  if (d.code && d.code !== "tesSUCCESS") throw new Error(`The ledger rejected it (${d.code}).`);
  return d;
}
