"use client";

// Optional collateral for a loan: the borrower locks a token in escrow to the desk. The
// desk holds the release key (a server-derived crypto-condition), so it can claim the
// collateral on default; the borrower reclaims it after the deadline otherwise. Uses
// XLS-85 escrow. Posted collateral is remembered per borrower.

import { useCallback, useEffect, useState } from "react";
import { TxButton, explain } from "./lending";
import { useWallet } from "./providers/WalletProvider";
import { MARKET } from "../lib/market";
import { readEscrow } from "../lib/escrow-read";
import { readTx } from "../lib/meta";
import { groupThousands, shortId } from "../lib/format";
import { Card, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";

const RIPPLE_EPOCH = 946684800;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const KEY = (a) => `flc:collateral:${a}`;

export function CollateralPanel() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [cond, setCond] = useState(null);
  const [record, setRecord] = useState(null);
  const [node, setNode] = useState(undefined);
  const [now, setNow] = useState(rippleNow());

  useEffect(() => {
    const t = setInterval(() => setNow(rippleNow()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!address || cond) return;
    let on = true;
    fetch("/api/collateral", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "condition", borrower: address }) })
      .then((r) => r.json())
      .then((d) => on && d.condition && setCond(d.condition))
      .catch(() => {});
    return () => { on = false; };
  }, [address, cond]);

  const restore = useCallback(async () => {
    if (!address) return;
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(KEY(address)) || "null"); } catch { saved = null; }
    setRecord(saved);
    if (saved) setNode(await readEscrow(saved.owner, saved.seq).catch(() => null));
    else setNode(undefined);
  }, [address]);
  useEffect(() => {
    restore();
    const t = setInterval(restore, 8000);
    return () => clearInterval(t);
  }, [restore]);

  const onPosted = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash || !address) return;
    const { tx } = await readTx(hash);
    const rec = { owner: address, seq: tx?.Sequence, tokenId, amount };
    try { window.localStorage.setItem(KEY(address), JSON.stringify(rec)); } catch { /* ignore */ }
    setRecord(rec);
    setNode(await readEscrow(address, tx?.Sequence).catch(() => null));
    setAmount("");
  }, [address, tokenId, amount]);

  const held = record && node && node !== null;
  const canReclaim = held && node.CancelAfter != null && now > node.CancelAfter;

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h2 className="font-medium">Secure with collateral (optional)</h2>
        {held ? (
          <>
            <p className="text-sm">Locked <span className="font-semibold tabular-nums">{groupThousands(record.amount)}</span> of {shortId(record.tokenId, 6)} to the desk. Sequence {record.seq}.</p>
            {canReclaim ? (
              <TxButton label="Reclaim collateral" variant="outline" explain={explain} disabled={!isConnected}
                tx={() => ({ TransactionType: "EscrowCancel", Account: address, Owner: address, OfferSequence: Number(record.seq) })}
                onResult={restore} />
            ) : (
              <p className="text-xs text-muted-foreground">The desk holds the release key and can claim it if a secured loan defaults. You can reclaim it after the deadline otherwise.</p>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">Lock a token as security. Optional, but a desk may offer better terms against collateral.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5"><Label htmlFor="c-tok">Token</Label><Input id="c-tok" value={tokenId} onChange={(e) => setTokenId(e.target.value.trim())} placeholder="token id" className="font-mono text-xs" /></div>
              <div className="space-y-1.5"><Label htmlFor="c-amt">Amount</Label><Input id="c-amt" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0" /></div>
            </div>
            <TxButton label="Lock collateral" variant="outline" explain={explain}
              disabled={!isConnected || !tokenId || !/^\d+$/.test(amount) || !cond}
              tx={() => ({ TransactionType: "EscrowCreate", Account: address, Amount: { mpt_issuance_id: tokenId, value: amount }, Destination: MARKET.operator, FinishAfter: rippleNow() + 8, CancelAfter: rippleNow() + 7 * 86400, Condition: cond })}
              onResult={onPosted} />
          </>
        )}
        {record && node === null && (
          <Alert><AlertTitle>Collateral released</AlertTitle><AlertDescription>Your posted collateral is no longer held.</AlertDescription></Alert>
        )}
      </CardContent>
    </Card>
  );
}
