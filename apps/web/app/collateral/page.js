"use client";

// Collateral: post a token as security to the desk (held in escrow) so you can borrow
// on better terms. If a secured loan defaults, the desk claims the collateral. The
// posted collateral is remembered for you; result codes are hidden.

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKET } from "../../lib/market";
import { readEscrow } from "../../lib/escrow-read";
import { makeCondition } from "../../lib/conditions";
import { readTx } from "../../lib/meta";
import { groupThousands, shortId } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "../../components/ui/button";

const RIPPLE_EPOCH = 946684800;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const KEY = (a) => `flc:collateral:${a}`;

export default function CollateralPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [tokenId, setTokenId] = useState("");
  const [amount, setAmount] = useState("");
  const [cond, setCond] = useState(null);
  const [record, setRecord] = useState(null);
  const [node, setNode] = useState(undefined); // undefined=loading, null=released, obj=held

  useEffect(() => {
    if (!cond) makeCondition().then(setCond);
  }, [cond]);

  const restore = useCallback(async () => {
    if (!address) return;
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(KEY(address)) || "null");
    } catch {
      saved = null;
    }
    setRecord(saved);
    if (saved) setNode(await readEscrow(address, saved.seq).catch(() => null));
  }, [address]);
  useEffect(() => {
    restore();
    const t = setInterval(restore, 8000);
    return () => clearInterval(t);
  }, [restore]);

  const onPosted = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash || !address) return;
    const { tx } = await readTx(hash);
    const rec = { seq: tx?.Sequence, tokenId, amount, condition: cond?.condition, fulfillment: cond?.fulfillment };
    try { window.localStorage.setItem(KEY(address), JSON.stringify(rec)); } catch { /* ignore */ }
    setRecord(rec);
    setNode(await readEscrow(address, tx?.Sequence).catch(() => null));
    setAmount("");
    setCond(null);
  }, [address, tokenId, amount, cond]);

  const held = record && node && node !== null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-2xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Secured loans</h1>
            <p className="mt-1 text-muted-foreground">
              Post a token as collateral, held safely in escrow by the desk. Secured borrowers can
              access larger loans; if a secured loan defaults, the desk claims the collateral.
            </p>
          </div>

          {held ? (
            <Card>
              <CardContent className="space-y-3 p-6">
                <div className="flex items-center gap-2 text-emerald-600">
                  <ShieldCheck className="h-5 w-5" />
                  <p className="font-medium">Collateral posted</p>
                </div>
                <p className="text-2xl font-semibold tabular-nums">{groupThousands(record.amount)} <span className="text-base font-normal text-muted-foreground">of {shortId(record.tokenId, 6)}</span></p>
                <p className="text-xs text-muted-foreground">Held by the desk until your secured loan is repaid.</p>
                <Link href="/borrow" className={buttonVariants({})}>Borrow against it →</Link>
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
                  tx={() => ({ TransactionType: "EscrowCreate", Account: address, Amount: { mpt_issuance_id: tokenId, value: amount }, Destination: MARKET.operator, FinishAfter: rippleNow() + 8, CancelAfter: rippleNow() + 7 * 86400, Condition: cond.condition })}
                  onResult={onPosted}
                />
                <p className="text-xs text-muted-foreground">The token must allow escrow and transfers (created on the Tokens page).</p>
              </CardContent>
            </Card>
          )}

          {record && node === null && (
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
