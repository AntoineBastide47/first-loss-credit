"use client";

// Sell a lending position without waiting for the pool to have cash.
//
// Withdrawing needs idle assets. Once the pool is lent out there is nothing to redeem, and
// with long loans that can last months, so the way out is to sell the shares. Listing
// escrows them to the desk with an asking price; a buyer pays the seller directly and the
// desk, which holds the release key, hands the shares over once it has seen the payment
// settle. The whole book is on the ledger: see lib/shares.js.

import { useCallback, useEffect, useState } from "react";
import { TxButton, explain } from "./lending";
import { useWallet } from "./providers/WalletProvider";
import { readMptoken } from "../lib/lending-read";
import { readTx } from "../lib/meta";
import { shareListings, listingValue, listingSpreadBps, isOpen, rippleNow, LISTING_WINDOWS, MAX_PRICE } from "../lib/shares";
import { assetSymbol, formatAmount, toBaseUnits, shareAmount } from "../lib/asset";
import { shortId, formatRippleTime } from "../lib/format";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Button } from "./ui/button";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

const POLL_MS = 8000;
const SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function SharesMarket({ market, vault, shares, onChanged }) {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;
  const asset = market.asset;
  const sym = assetSymbol(asset);

  const [book, setBook] = useState([]);
  const [sellShares, setSellShares] = useState("");
  const [price, setPrice] = useState("");
  const [windowId, setWindowId] = useState("1d");
  const [cond, setCond] = useState(null);
  const [optedIn, setOptedIn] = useState(true);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const [now, setNow] = useState(rippleNow());

  useEffect(() => {
    const t = setInterval(() => setNow(rippleNow()), 1000);
    return () => clearInterval(t);
  }, []);

  // The release condition is derived from the seller's address, so it is kept with the
  // address it belongs to rather than reused across a wallet switch.
  useEffect(() => {
    if (!address) return undefined;
    let on = true;
    fetch("/api/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "condition", seller: address }),
    })
      .then((r) => r.json())
      .then((d) => on && d.condition && setCond({ seller: address, condition: d.condition }))
      .catch(() => {});
    return () => { on = false; };
  }, [address]);
  const condition = cond?.seller === address ? cond.condition : null;

  const load = useCallback(async () => {
    setBook(await shareListings(market).catch(() => []));
    if (address) setOptedIn(!!(await readMptoken(address, market.shareMptId).catch(() => null)));
  }, [market, address]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const held = BigInt(shares ?? "0");
  const sellValid = (() => {
    try {
      const n = BigInt(sellShares || "0");
      return n > 0n && n <= held;
    } catch {
      return false;
    }
  })();
  const priceBase = (() => {
    try {
      return price ? BigInt(toBaseUnits(asset, price)) : 0n;
    } catch {
      return 0n;
    }
  })();
  const priceValid = priceBase > 0n && priceBase <= BigInt(MAX_PRICE);
  const windowSeconds = LISTING_WINDOWS.find((w) => w.id === windowId)?.seconds ?? 86400;

  const mine = book.filter((l) => l.seller === address);
  const others = book.filter((l) => l.seller !== address);

  const buy = useCallback(async (listing) => {
    setBusy(`buy-${listing.seq}`);
    setNote(null);
    try {
      // Pay the seller directly, tagged with the listing so one payment settles one
      // listing, then ask the desk to release the shares against that payment.
      const submitted = await walletManager.signAndSubmit({
        TransactionType: "Payment",
        Account: address,
        Destination: listing.seller,
        DestinationTag: Number(listing.seq),
        Amount: asset.kind === "MPT" ? { mpt_issuance_id: asset.issuanceId, value: listing.price } : listing.price,
      });
      const paymentHash = submitted?.hash || submitted?.id;
      if (!paymentHash) throw new Error("The wallet did not return a payment hash.");
      // The desk only settles against a validated payment, so wait for it to land first.
      const { meta } = await readTx(paymentHash);
      if (meta?.TransactionResult !== "tesSUCCESS") throw new Error(`The payment did not go through (${meta?.TransactionResult}).`);
      const r = await fetch("/api/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "fill", vaultId: market.vaultId, owner: listing.seller, seq: listing.seq, buyer: address, paymentHash }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setNote({ ok: `Bought ${d.shares} shares.` });
      load();
      onChanged?.();
    } catch (e) {
      setNote({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [walletManager, address, asset, market.vaultId, load, onChanged]);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="font-medium">Sell your position</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Withdrawing needs idle assets in the pool. When it is lent out you can sell your shares
            instead: list them at a price, and a buyer takes over your position and its yield.
          </p>
        </div>

        {!optedIn && isConnected && (
          <Alert variant="warning">
            <AlertTitle>Enable this market’s shares</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>Your wallet has to accept this market’s shares before you can buy a position.</p>
              <TxButton
                label="Enable"
                explain={explain}
                tx={() => ({ TransactionType: "MPTokenAuthorize", Account: address, MPTokenIssuanceID: market.shareMptId })}
                onResult={load}
              />
            </AlertDescription>
          </Alert>
        )}

        {held > 0n && (
          <div className="space-y-3 rounded-lg border border-border/60 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="s-shares">Shares</Label>
                  <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setSellShares(held.toString())}>
                    All ({held.toString()})
                  </button>
                </div>
                <Input id="s-shares" inputMode="numeric" value={sellShares} onChange={(e) => setSellShares(e.target.value.trim())} placeholder="0" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-price">Asking price ({sym})</Label>
                <Input id="s-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.trim())} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="s-window">Open for</Label>
                <select id="s-window" className={SELECT_CLASS} value={windowId} onChange={(e) => setWindowId(e.target.value)}>
                  {LISTING_WINDOWS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
                </select>
              </div>
            </div>
            {sellValid && vault && (
              <p className="text-xs text-muted-foreground">
                Those shares redeem for {formatAmount(asset, listingValue(vault, { shares: sellShares }))} {sym} when the pool has
                the cash. Asking less is the discount you pay to get out now.
              </p>
            )}
            {price && !priceValid && (
              <p className="text-xs text-destructive">
                The most you can ask for one listing is {formatAmount(asset, String(MAX_PRICE))} {sym}.
              </p>
            )}
            <TxButton
              label="List for sale"
              variant="outline"
              explain={explain}
              disabled={!isConnected || !sellValid || !priceValid || !condition}
              tx={() => ({
                TransactionType: "EscrowCreate",
                Account: address,
                Amount: shareAmount(market.shareMptId, sellShares),
                Destination: market.operator,
                DestinationTag: Number(priceBase),
                FinishAfter: rippleNow() + 8,
                CancelAfter: rippleNow() + windowSeconds,
                Condition: condition,
              })}
              onResult={({ code }) => {
                if (code === "tesSUCCESS") { setSellShares(""); setPrice(""); }
                load();
                onChanged?.();
              }}
            />
            <p className="text-xs text-muted-foreground">
              Listed shares are locked until the listing expires, so pick a window you are happy to wait out.
            </p>
          </div>
        )}

        {mine.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Your listings</h3>
            {mine.map((l) => {
              const expired = l.cancelAfter != null && now > Number(l.cancelAfter);
              return (
                <div key={l.seq} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 p-3 text-sm">
                  <span className="tabular-nums">{l.shares} shares for {formatAmount(asset, l.price)} {sym}</span>
                  {expired ? (
                    <TxButton
                      label="Take back"
                      variant="outline"
                      explain={explain}
                      tx={() => ({ TransactionType: "EscrowCancel", Account: address, Owner: address, OfferSequence: Number(l.seq) })}
                      onResult={() => { load(); onChanged?.(); }}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">open until {formatRippleTime(l.cancelAfter)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">Positions for sale</h3>
          {others.length === 0 && <p className="text-xs text-muted-foreground">Nobody is selling a position in this market right now.</p>}
          {others.map((l) => {
            const spread = listingSpreadBps(vault, l);
            const open = isOpen(l, now);
            return (
              <div key={`${l.seller}-${l.seq}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 p-3 text-sm">
                <div>
                  <p className="tabular-nums">{l.shares} shares for {formatAmount(asset, l.price)} {sym}</p>
                  <p className="text-xs text-muted-foreground">
                    from {shortId(l.seller, 6)}
                    {spread != null && ` · ${spread >= 0 ? "+" : ""}${(spread / 100).toFixed(1)}% vs redemption value`}
                    {vault && ` · worth ${formatAmount(asset, listingValue(vault, l))} ${sym}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!isConnected || !open || !optedIn || busy === `buy-${l.seq}`}
                  onClick={() => buy(l)}
                >
                  {busy === `buy-${l.seq}` ? "Buying…" : "Buy"}
                </Button>
              </div>
            );
          })}
        </div>

        {note?.ok && (
          <Alert variant="success">
            <AlertTitle>Done</AlertTitle>
            <AlertDescription>{note.ok}</AlertDescription>
          </Alert>
        )}
        {note?.error && (
          <Alert variant="destructive">
            <AlertTitle>Didn’t go through</AlertTitle>
            <AlertDescription className="break-all">{note.error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
