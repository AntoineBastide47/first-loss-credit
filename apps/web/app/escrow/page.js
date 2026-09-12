"use client";

// Escrow: lock XRP to someone and release it later — after a time, and optionally only
// with a secret you hold. Created escrows are remembered for you (no ids to paste);
// result codes are hidden.

import { useCallback, useEffect, useState } from "react";
import { xrpToDrops } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readEscrow } from "../../lib/escrow-read";
import { makeCondition } from "../../lib/conditions";
import { readTx } from "../../lib/meta";
import { formatDrops, groupThousands } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

const RIPPLE_EPOCH = 946684800;
const rippleNow = () => Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;
const xrp = (d) => groupThousands(formatDrops(String(d ?? "0")));
const big = (v) => BigInt(v ?? "0");
const KEY = (a) => `flc:escrows:${a}`;

function loadList(a) {
  try {
    return JSON.parse(window.localStorage.getItem(KEY(a)) || "[]");
  } catch {
    return [];
  }
}
function saveList(a, list) {
  try {
    window.localStorage.setItem(KEY(a), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export default function EscrowPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [minutes, setMinutes] = useState("1");
  const [useSecret, setUseSecret] = useState(true);
  const [cond, setCond] = useState(null);

  const [records, setRecords] = useState([]); // stored escrow records
  const [nodes, setNodes] = useState({}); // seq -> escrow node
  const [now, setNow] = useState(rippleNow());

  useEffect(() => {
    const t = setInterval(() => setNow(rippleNow()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (useSecret && !cond) makeCondition().then(setCond);
  }, [useSecret, cond]);

  const refresh = useCallback(async () => {
    if (!address) return;
    const list = loadList(address);
    setRecords(list);
    const entries = await Promise.all(list.map((r) => readEscrow(address, r.seq).then((n) => [r.seq, n]).catch(() => [r.seq, null])));
    setNodes(Object.fromEntries(entries));
  }, [address]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  const onCreated = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash || !address) return;
    const { tx } = await readTx(hash);
    const rec = { seq: tx?.Sequence, to, amount, condition: useSecret ? cond?.condition : null, fulfillment: useSecret ? cond?.fulfillment : null };
    saveList(address, [rec, ...loadList(address)]);
    setTo("");
    setAmount("");
    setCond(null);
    refresh();
  }, [address, to, amount, useSecret, cond, refresh]);

  const amountValid = (() => { try { return amount && big(xrpToDrops(amount)) > 0n; } catch { return false; } })();

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Locked payments</h1>
            <p className="mt-1 text-muted-foreground">
              Set XRP aside for someone and release it later — after a delay, and optionally only
              when you reveal a secret. Cancel to get it back after the deadline.
            </p>
          </div>

          <Card>
            <CardContent className="space-y-3 p-6">
              <h2 className="font-medium">Lock a payment</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5"><Label htmlFor="to">Recipient</Label><Input id="to" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="r…" className="font-mono text-xs" /></div>
                <div className="space-y-1.5"><Label htmlFor="amt">Amount (XRP)</Label><Input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} placeholder="0.00" /></div>
                <div className="space-y-1.5"><Label htmlFor="min">Release after (minutes)</Label><Input id="min" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.trim())} placeholder="1" /></div>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4" checked={useSecret} onChange={(e) => setUseSecret(e.target.checked)} /> Require a secret to release (you hold it)</label>
              {useSecret && (
                <p className="text-xs text-muted-foreground">The secret is kept in this browser. If you clear it before releasing, only Cancel after the deadline can return the funds.</p>
              )}
              <TxButton
                label="Lock payment"
                explain={explain}
                disabled={!isConnected || !to || !amountValid}
                tx={() => {
                  const t = { TransactionType: "EscrowCreate", Account: address, Amount: xrpToDrops(amount), Destination: to };
                  const secs = Math.max(1, Number(minutes || 1)) * 60;
                  t.FinishAfter = rippleNow() + secs;
                  t.CancelAfter = rippleNow() + secs + 86400; // reclaimable a day after release opens
                  if (useSecret && cond) t.Condition = cond.condition;
                  return t;
                }}
                onResult={onCreated}
              />
            </CardContent>
          </Card>

          <div className="space-y-3">
            <h2 className="text-sm font-medium text-muted-foreground">Your locked payments</h2>
            {records.length === 0 && <p className="text-sm text-muted-foreground">None yet.</p>}
            {records.map((r) => {
              const node = nodes[r.seq];
              const gone = node === null;
              const finishAfter = node?.FinishAfter;
              const canRelease = finishAfter == null || now > finishAfter;
              return (
                <Card key={r.seq}>
                  <CardContent className="space-y-3 p-6">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-lg font-semibold tabular-nums">{xrp(xrpToDrops(r.amount || "0"))} XRP</p>
                        <p className="text-xs text-muted-foreground break-all">to {r.to}</p>
                      </div>
                      <span className="text-sm text-muted-foreground">
                        {gone ? "Released / cancelled" : canRelease ? "Ready to release" : `unlocks in ${finishAfter - now}s`}
                      </span>
                    </div>
                    {!gone && (
                      <div className="flex flex-wrap gap-2">
                        <TxButton
                          label="Release"
                          explain={explain}
                          disabled={!isConnected}
                          tx={() => {
                            const t = { TransactionType: "EscrowFinish", Account: address, Owner: address, OfferSequence: Number(r.seq) };
                            if (r.condition) { t.Condition = r.condition; t.Fulfillment = r.fulfillment; }
                            return t;
                          }}
                          onResult={refresh}
                        />
                        <TxButton
                          label="Cancel"
                          variant="outline"
                          explain={explain}
                          disabled={!isConnected}
                          tx={() => ({ TransactionType: "EscrowCancel", Account: address, Owner: address, OfferSequence: Number(r.seq) })}
                          onResult={refresh}
                        />
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
