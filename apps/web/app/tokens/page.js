"use client";

// Tokens: issue a Multi-Purpose Token, optionally require approval for holders, and
// send it. The token id is remembered for you; result codes are hidden.

import { useCallback, useEffect, useState } from "react";
import { convertStringToHex, MPTokenIssuanceCreateFlags as F } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readMptIssuance, readMptoken, isMptAuthorized } from "../../lib/mpt-read";
import { mptIssuanceId, readTx } from "../../lib/meta";
import { formatScaled, groupThousands } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";

const KEY = (a) => `flc:my-token:${a}`;

function Field({ id, label, value, onChange, placeholder, mono }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} className={mono ? "font-mono text-xs" : ""} />
    </div>
  );
}

export default function TokensPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [id, setId] = useState("");
  const [issuance, setIssuance] = useState(null);
  const [ticker, setTicker] = useState("FLC");
  const [decimals, setDecimals] = useState("2");
  const [requireApproval, setRequireApproval] = useState(false);

  const [holder, setHolder] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [holderTok, setHolderTok] = useState(null);

  const scale = issuance?.AssetScale ?? Number(decimals || 0);

  useEffect(() => {
    if (!address) return;
    try {
      const saved = window.localStorage.getItem(KEY(address));
      if (saved) setId(saved);
    } catch {
      /* ignore */
    }
  }, [address]);

  const loadIssuance = useCallback(async (x) => {
    if (!x) return;
    try {
      setIssuance(await readMptIssuance(x));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (id) loadIssuance(id);
  }, [id, loadIssuance]);

  const refreshHolder = useCallback(async () => {
    if (!id || !holder) return;
    try {
      setHolderTok(await readMptoken(holder, id));
    } catch {
      /* ignore */
    }
  }, [id, holder]);

  const onCreated = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash) return;
    const { meta } = await readTx(hash);
    const newId = mptIssuanceId(meta);
    if (newId) {
      setId(newId);
      try { window.localStorage.setItem(KEY(address), newId); } catch { /* ignore */ }
    }
  }, [address]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Tokens</h1>
            <p className="mt-1 text-muted-foreground">
              Issue your own token and send it. Turn on approvals to control who can hold it.
            </p>
          </div>

          {!issuance ? (
            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="font-medium">Create a token</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="ticker" label="Ticker" value={ticker} onChange={setTicker} placeholder="FLC" />
                  <Field id="dec" label="Decimals" value={decimals} onChange={setDecimals} placeholder="2" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} /> Require approval before someone can hold it
                </label>
                <TxButton
                  label="Create token"
                  explain={explain}
                  disabled={!isConnected}
                  tx={() => ({
                    TransactionType: "MPTokenIssuanceCreate",
                    Account: address,
                    Flags: F.tfMPTCanTransfer | F.tfMPTCanEscrow | (requireApproval ? F.tfMPTRequireAuth : 0),
                    AssetScale: Number(decimals || 0),
                    MaximumAmount: "1000000000000",
                    MPTokenMetadata: convertStringToHex(JSON.stringify({ ticker: (ticker || "TKN").toUpperCase().slice(0, 6), name: `${ticker || "Token"}`, icon: "https://example.com/t.png", asset_class: "other", issuer_name: "First-Loss Credit" })),
                  })}
                  onResult={onCreated}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              <Card>
                <CardContent className="grid grid-cols-3 gap-4 p-6">
                  <div>
                    <p className="text-xs text-muted-foreground">Decimals</p>
                    <p className="mt-1 text-xl font-semibold">{issuance.AssetScale ?? 0}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">In circulation</p>
                    <p className="mt-1 text-xl font-semibold tabular-nums">{groupThousands(formatScaled(issuance.OutstandingAmount ?? "0", scale))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Approvals</p>
                    <p className="mt-1 text-xl font-semibold">{(Number(issuance.Flags) & F.tfMPTRequireAuth) !== 0 ? "Required" : "Open"}</p>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 sm:grid-cols-2">
                <Card>
                  <CardContent className="space-y-3 p-6">
                    <h2 className="font-medium">Send</h2>
                    <Field id="to" label="Recipient" value={holder} onChange={setHolder} placeholder="r…" mono />
                    <Field id="amt" label="Amount" value={sendAmt} onChange={setSendAmt} placeholder="0" />
                    <TxButton
                      label="Send"
                      explain={explain}
                      disabled={!isConnected || !holder || !/^\d+$/.test(sendAmt)}
                      tx={() => ({ TransactionType: "Payment", Account: address, Destination: holder, Amount: { mpt_issuance_id: id, value: sendAmt } })}
                      onResult={refreshHolder}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="space-y-3 p-6">
                    <h2 className="font-medium">Approvals</h2>
                    <p className="text-xs text-muted-foreground">If approval is required: the holder opts in, then you approve them.</p>
                    <Field id="h" label="Holder" value={holder} onChange={setHolder} placeholder="r…" mono />
                    <div className="flex flex-wrap gap-2">
                      <TxButton label="Opt in (you)" explain={explain} disabled={!isConnected} tx={() => ({ TransactionType: "MPTokenAuthorize", Account: address, MPTokenIssuanceID: id })} onResult={refreshHolder} />
                      <TxButton label="Approve holder" variant="outline" explain={explain} disabled={!isConnected || !holder} tx={() => ({ TransactionType: "MPTokenAuthorize", Account: address, MPTokenIssuanceID: id, Holder: holder })} onResult={refreshHolder} />
                    </div>
                    <Button variant="secondary" size="sm" onClick={refreshHolder} disabled={!holder}>Check holder</Button>
                    {holderTok !== null && (
                      <p className="text-xs text-muted-foreground">{holderTok ? `${groupThousands(formatScaled(holderTok.MPTAmount ?? "0", scale))} · ${isMptAuthorized(holderTok) ? "approved" : "awaiting approval"}` : "not opted in"}</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
