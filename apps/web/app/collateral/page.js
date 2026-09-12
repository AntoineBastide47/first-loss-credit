"use client";

// Collateral: the borrower locks a token in escrow to the desk as security. The escrow
// carries a crypto-condition only the desk can open (the release key is derived from
// the desk seed server-side, never given to the browser), so the desk controls the
// collateral: it can claim it, and the borrower can only reclaim it after the deadline
// if the desk has not. Posted collateral is remembered for you; result codes are hidden.
//
// The escrow has no on-chain link to a loan (the protocol imposes none), so the desk
// keeps the borrower/sequence mapping off-ledger and claims by entering it.

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKET } from "../../lib/market";
import { readEscrow } from "../../lib/escrow-read";
import { readTx } from "../../lib/meta";
import { groupThousands, shortId } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button, buttonVariants } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";

const RIPPLE_EPOCH = 946684800;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const KEY = (a) => `flc:collateral:${a}`;

// The desk's claim form. Any signed-in account may call the endpoint, but only the
// desk can open the condition, so a claim delivers the collateral to the desk.
function DeskClaim() {
  const [borrower, setBorrower] = useState("");
  const [seq, setSeq] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [state, setState] = useState(null); // { busy } | { error } | { code }

  const doClaim = useCallback(async () => {
    setState({ busy: true });
    try {
      const r = await fetch("/api/collateral", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "claim", owner: borrower, seq: Number(seq), tokenId: tokenId || undefined }) });
      const d = await r.json();
      if (d.code === "tesSUCCESS") setState({ code: d.code });
      else setState({ error: d.error || explain("EscrowFinish", d.code) || "Could not claim the collateral." });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    }
  }, [borrower, seq, tokenId]);

  return (
    <Card>
      <CardContent className="space-y-3 p-6">
        <h2 className="font-medium">Claim collateral to the desk</h2>
        <p className="text-xs text-muted-foreground">Enter the borrower and the escrow sequence you recorded for a defaulted secured loan.</p>
        <div className="space-y-1.5"><Label htmlFor="b">Borrower</Label><Input id="b" value={borrower} onChange={(e) => setBorrower(e.target.value.trim())} placeholder="r…" className="font-mono text-xs" /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="s">Escrow sequence</Label><Input id="s" inputMode="numeric" value={seq} onChange={(e) => setSeq(e.target.value.trim())} placeholder="0" /></div>
          <div className="space-y-1.5"><Label htmlFor="t">Token</Label><Input id="t" value={tokenId} onChange={(e) => setTokenId(e.target.value.trim())} placeholder="token id" className="font-mono text-xs" /></div>
        </div>
        <Button variant="outline" onClick={doClaim} disabled={!borrower || !/^\d+$/.test(seq) || state?.busy}>{state?.busy ? "Claiming…" : "Claim to desk"}</Button>
        {state?.code === "tesSUCCESS" && <Alert variant="success"><AlertTitle>Claimed</AlertTitle><AlertDescription>The collateral was delivered to the desk.</AlertDescription></Alert>}
        {state?.error && <Alert variant="destructive"><AlertTitle>Didn’t go through</AlertTitle><AlertDescription className="break-all">{state.error}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  );
}

export default function CollateralPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;
  const isOperator = address === MARKET.operator;

  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [cond, setCond] = useState(null); // desk-issued condition for this borrower
  const [record, setRecord] = useState(null);
  const [node, setNode] = useState(undefined); // undefined=loading, null=released, obj=held
  const [now, setNow] = useState(rippleNow());

  useEffect(() => {
    const t = setInterval(() => setNow(rippleNow()), 1000);
    return () => clearInterval(t);
  }, []);

  // Ask the desk for this borrower's collateral condition. The desk keeps the matching
  // release key; the browser only ever sees the public condition.
  useEffect(() => {
    if (!address || cond || isOperator) return;
    let on = true;
    fetch("/api/collateral", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "condition", borrower: address }) })
      .then((r) => r.json())
      .then((d) => on && d.condition && setCond(d.condition))
      .catch(() => {});
    return () => { on = false; };
  }, [address, cond, isOperator]);

  const restore = useCallback(async () => {
    if (!address) return;
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(KEY(address)) || "null");
    } catch {
      saved = null;
    }
    setRecord(saved);
    if (saved) setNode(await readEscrow(saved.owner, saved.seq).catch(() => null));
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
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-2xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Secured collateral</h1>
            <p className="mt-1 text-muted-foreground">
              Lock a token in escrow as security for the desk. Only the desk can release it, so it
              can claim the collateral if your secured loan defaults. If the desk never claims, you
              reclaim it yourself after the deadline.
            </p>
          </div>

          {isOperator ? (
            <DeskClaim />
          ) : held ? (
            <Card>
              <CardContent className="space-y-3 p-6">
                <div className="flex items-center gap-2 text-emerald-600">
                  <ShieldCheck className="h-5 w-5" />
                  <p className="font-medium">Collateral posted</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">{groupThousands(record.amount)} <span className="text-base font-normal text-muted-foreground">of {shortId(record.tokenId, 6)}</span></p>
                <p className="text-xs text-muted-foreground">Held in escrow for the desk. Escrow sequence {record.seq} (the desk needs this to claim on default).</p>
                <Link href="/borrow" className={buttonVariants({})}>Borrow against it →</Link>
                {canReclaim ? (
                  <TxButton
                    label="Reclaim collateral"
                    variant="outline"
                    explain={explain}
                    disabled={!isConnected}
                    tx={() => ({ TransactionType: "EscrowCancel", Account: address, Owner: address, OfferSequence: Number(record.seq) })}
                    onResult={restore}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">You can reclaim it after {new Date((node.CancelAfter + RIPPLE_EPOCH) * 1000).toLocaleString()} if the desk has not claimed it.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="font-medium">Post collateral</h2>
                <div className="space-y-1.5"><Label htmlFor="tok">Token</Label><Input id="tok" value={tokenId} onChange={(e) => setTokenId(e.target.value.trim())} placeholder="token id (from the Tokens page)" className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label htmlFor="amt">Amount</Label><Input id="amt" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0" /></div>
                <TxButton
                  label="Post collateral"
                  explain={explain}
                  disabled={!isConnected || !tokenId || !/^\d+$/.test(amount) || !cond}
                  tx={() => ({ TransactionType: "EscrowCreate", Account: address, Amount: { mpt_issuance_id: tokenId, value: amount }, Destination: MARKET.operator, FinishAfter: rippleNow() + 8, CancelAfter: rippleNow() + 7 * 86400, Condition: cond })}
                  onResult={onPosted}
                />
                <p className="text-xs text-muted-foreground">The token must allow escrow and transfers (created on the Tokens page).{!cond && " Preparing the collateral condition…"}</p>
              </CardContent>
            </Card>
          )}

          {!isOperator && record && node === null && (
            <Alert>
              <AlertTitle>Collateral released</AlertTitle>
              <AlertDescription>Your previously posted collateral is no longer held.</AlertDescription>
            </Alert>
          )}
        </div>
      </main>
    </div>
  );
}
