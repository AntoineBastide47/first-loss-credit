"use client";

// Optional collateral for a loan: the borrower locks the market's own asset in an escrow
// to the desk. The desk holds the release key (a server-derived crypto-condition), so it
// can claim the collateral on default; the borrower reclaims it after the deadline
// otherwise. Uses XLS-85 escrow.
//
// Collateral is denominated in the market's asset because that is the only thing the desk
// can credit against a loan: valuing anything else would need a price it does not have.
// What is locked here raises the borrowing limit the desk quotes on this market.
//
// Posted collateral is read from the ledger, the same way the desk reads it, so it shows
// on any device and never depends on what this browser wrote down.

import { useCallback, useEffect, useState } from "react";
import { TxButton, explain } from "./lending";
import { useWallet } from "./providers/WalletProvider";
import { escrowsTo } from "../lib/lending-read";
import { assetSymbol, formatAmount, toBaseUnits, assetAmount, isPositiveAmount } from "../lib/asset";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

const RIPPLE_EPOCH = 946684800;
const LOCK_SECONDS = 7 * 86400;
const POLL_MS = 8000;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

/** Base-unit value of an escrowed amount, or null when it is not this market's asset. */
function valueOf(amount, asset) {
  if (asset.kind === "MPT") {
    return amount && typeof amount === "object" && amount.mpt_issuance_id === asset.issuanceId
      ? String(amount.value).split(".")[0]
      : null;
  }
  return typeof amount === "string" ? amount : null;
}

export function CollateralPanel({ market }) {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;
  const asset = market.asset;
  const sym = assetSymbol(asset);

  const [amount, setAmount] = useState("");
  const [cond, setCond] = useState(null);
  const [locked, setLocked] = useState([]);
  const [now, setNow] = useState(rippleNow());

  useEffect(() => {
    const t = setInterval(() => setNow(rippleNow()), 1000);
    return () => clearInterval(t);
  }, []);

  // The release condition is derived from the borrower's address, so it is kept with the
  // address it belongs to: a condition left over from a previously connected account
  // would lock collateral the desk could not open.
  useEffect(() => {
    if (!address) return undefined;
    let on = true;
    fetch("/api/collateral", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "condition", borrower: address }),
    })
      .then((r) => r.json())
      .then((d) => on && d.condition && setCond({ borrower: address, condition: d.condition }))
      .catch(() => {});
    return () => { on = false; };
  }, [address]);
  const condition = cond?.borrower === address ? cond.condition : null;

  const load = useCallback(async () => {
    if (!address) {
      setLocked([]);
      return;
    }
    const all = await escrowsTo(address, market.operator).catch(() => []);
    setLocked(
      all
        .map((e) => ({ ...e, value: valueOf(e.amount, asset) }))
        .filter((e) => e.value != null),
    );
  }, [address, market.operator, asset]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const total = locked.reduce((sum, e) => sum + BigInt(e.value), 0n);
  const valid = isPositiveAmount(asset, amount);

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h2 className="font-medium">Secure with collateral (optional)</h2>
        <p className="text-xs text-muted-foreground">
          Lock {sym} with the desk and it raises what you can borrow on this market. The desk can claim it
          if a loan defaults. Otherwise it comes back to you after the deadline.
        </p>

        {total > 0n && (
          <p className="text-sm">
            Locked <span className="font-semibold tabular-nums">{formatAmount(asset, total)} {sym}</span> to the desk.
          </p>
        )}

        {locked.map((e) => (
          <div key={e.seq} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3 text-sm">
            <span className="tabular-nums">{formatAmount(asset, e.value)} {sym}</span>
            {e.cancelAfter != null && now > Number(e.cancelAfter) ? (
              <TxButton
                label="Reclaim"
                variant="outline"
                explain={explain}
                disabled={!isConnected}
                tx={() => ({ TransactionType: "EscrowCancel", Account: address, Owner: address, OfferSequence: Number(e.seq) })}
                onResult={load}
              />
            ) : (
              <span className="text-xs text-muted-foreground">held until {new Date((Number(e.cancelAfter) + RIPPLE_EPOCH) * 1000).toLocaleString()}</span>
            )}
          </div>
        ))}

        <div className="space-y-1.5">
          <Label htmlFor="c-amt">Amount to lock ({sym})</Label>
          <Input id="c-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" />
        </div>
        <TxButton
          label={`Lock ${sym} as collateral`}
          variant="outline"
          explain={explain}
          disabled={!isConnected || !valid || !condition}
          tx={() => ({
            TransactionType: "EscrowCreate",
            Account: address,
            Amount: assetAmount(asset, toBaseUnits(asset, amount)),
            Destination: market.operator,
            FinishAfter: rippleNow() + 8,
            CancelAfter: rippleNow() + LOCK_SECONDS,
            Condition: condition,
          })}
          onResult={({ code }) => {
            if (code === "tesSUCCESS") setAmount("");
            load();
          }}
        />
        {!condition && isConnected && (
          <Alert>
            <AlertTitle>Desk unavailable</AlertTitle>
            <AlertDescription>The desk is not reachable right now, so collateral cannot be locked.</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
