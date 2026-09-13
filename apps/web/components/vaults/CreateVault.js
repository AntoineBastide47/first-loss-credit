"use client";

// Create a market end to end. You configure it, you mint its token, and you fund its
// first-loss cover; the desk provisions the vault and broker on the ledger.
//
// The desk has to be the on-chain owner: XLS-66 ties the broker owner to the vault owner,
// and only that account can attach a LoanSet CounterpartySignature (a CPT-prefixed
// signature no browser wallet can produce) or deposit cover (a non-owner gets
// tecNO_PERMISSION). A vault owned by your wallet could therefore never lend. This way a
// market you create is immediately usable: deposits, loans, cover and defaults all work.

import { useCallback, useEffect, useMemo, useState } from "react";
import { convertStringToHex, MPTokenIssuanceCreateFlags as MF } from "xrpl";
import { TxButton, explain } from "../lending";
import { DESK_OPERATOR } from "../../lib/market";
import { readTx, mptIssuanceId } from "../../lib/meta";
import { toBaseUnits, isPositiveAmount, assetAmount, assetSymbol } from "../../lib/asset";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";

const CREDENTIAL_TYPES = ["KYC verified", "Accredited investor", "Institutional"];
const sel = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

function Step({ n, title, done, active, children }) {
  return (
    <Card className={active ? "border-foreground/40" : done ? "opacity-70" : "opacity-50"}>
      <CardContent className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${done ? "bg-emerald-500 text-white" : active ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{done ? "✓" : n}</span>
          <h3 className="font-medium">{title}</h3>
        </div>
        {(active || !done) && children}
      </CardContent>
    </Card>
  );
}

export function CreateVault({ address, isConnected, onCreated }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("XRP");
  const [tokenMode, setTokenMode] = useState("new");
  const [issuanceId, setIssuanceId] = useState("");
  const [decimals, setDecimals] = useState("2");
  const [symbol, setSymbol] = useState("");
  const [gated, setGated] = useState(false);
  const [credType, setCredType] = useState(CREDENTIAL_TYPES[0]);
  const [feePct, setFeePct] = useState("0");
  const [minCoverPct, setMinCoverPct] = useState("10");
  const [coverAmt, setCoverAmt] = useState("");

  const [tokenId, setTokenId] = useState(null);
  const [created, setCreated] = useState(null); // { vaultId, shareMptId, brokerId, domainId }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [coverDone, setCoverDone] = useState(false);
  const [saved, setSaved] = useState(false);

  const needToken = kind === "MPT" && tokenMode === "new";
  const effIssuanceId = kind === "MPT" ? (needToken ? tokenId : issuanceId) : null;
  const asset = useMemo(
    () => (kind === "MPT"
      ? { kind: "MPT", issuanceId: effIssuanceId, scale: Number(decimals || 0), symbol: (symbol || "TOKEN").toUpperCase().slice(0, 8) }
      : { kind: "XRP" }),
    [kind, effIssuanceId, decimals, symbol],
  );
  const sym = assetSymbol(asset);

  const nameOk = name.trim().length > 0;
  const assetOk = kind === "XRP"
    ? true
    : needToken
      ? /^\d+$/.test(decimals) && symbol.trim().length > 0
      : /^[0-9A-Fa-f]{48}$/.test(issuanceId) && /^\d+$/.test(decimals) && symbol.trim().length > 0;
  const detailsOk = nameOk && assetOk;
  const wantCover = coverAmt !== "" && isPositiveAmount(asset, coverAmt);

  const onToken = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash) return;
    const { meta } = await readTx(hash);
    const id = mptIssuanceId(meta);
    if (id) setTokenId(id);
  }, []);

  const provision = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "create",
          name,
          asset: kind === "MPT" ? { kind: "MPT", issuanceId: effIssuanceId } : { kind: "XRP" },
          gated,
          credentialType: convertStringToHex(credType),
          issuer: address, // you issue the credentials that admit depositors
          feePct,
          minCoverPct,
        }),
      });
      const d = await r.json();
      if (d.vaultId && d.brokerId) setCreated(d);
      else setError(d.error || "Could not create the vault.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
    // `address` must stay in these deps: without it this callback closes over a stale
    // (often null) address and provisions a gated vault that does not trust the creator.
  }, [kind, effIssuanceId, gated, credType, feePct, minCoverPct, address, name]);

  // After the creator pays the desk, the desk deposits the same amount as cover.
  const onCoverPaid = useCallback(async ({ code, hash }) => {
    if (code !== "tesSUCCESS" || !hash) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "cover", brokerId: created.brokerId, asset, amount: toBaseUnits(asset, coverAmt), paymentHash: hash }),
      });
      const d = await r.json();
      if (d.code === "tesSUCCESS") setCoverDone(true);
      else setError(d.error || explain("LoanBrokerCoverDeposit", d.code) || "Cover deposit failed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [created, asset, coverAmt]);

  useEffect(() => {
    if (saved || !created?.vaultId || !created?.brokerId) return;
    if (wantCover && !coverDone) return;
    setSaved(true);
    onCreated({
      id: `user-${created.vaultId.slice(0, 10).toLowerCase()}`,
      name: name.trim() || "My market",
      asset,
      vaultId: created.vaultId,
      shareMptId: created.shareMptId,
      brokerId: created.brokerId,
      operator: created.operator || DESK_OPERATOR,
      creator: address,
      seedLoanId: null,
      ...(gated && created.domainId ? { domainId: created.domainId, gate: { issuer: address, credentialType: credType } } : {}),
    });
  }, [saved, created, wantCover, coverDone, name, asset, address, gated, credType, onCreated]);

  const order = ["details", needToken && "token", "vault", wantCover && "cover"].filter(Boolean);
  const stepNo = (k) => order.indexOf(k) + 1;

  return (
    <div className="space-y-3">
      <Step n={stepNo("details")} title="Market details" active={!created} done={!!created}>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="v-name">Name</Label>
            <Input id="v-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Credit Vault" disabled={!!created} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="v-kind">Asset</Label>
              <select id="v-kind" value={kind} onChange={(e) => setKind(e.target.value)} disabled={!!created} className={sel}>
                <option value="XRP">XRP</option>
                <option value="MPT">A token (MPT)</option>
              </select>
            </div>
            {kind === "MPT" && (
              <div className="space-y-1.5">
                <Label htmlFor="v-tmode">Token</Label>
                <select id="v-tmode" value={tokenMode} onChange={(e) => setTokenMode(e.target.value)} disabled={!!created} className={sel}>
                  <option value="new">Mint a new token</option>
                  <option value="existing">Use an existing token</option>
                </select>
              </div>
            )}
          </div>
          {kind === "MPT" && (
            <div className="grid gap-3 sm:grid-cols-3">
              {tokenMode === "existing" && (
                <div className="space-y-1.5 sm:col-span-3">
                  <Label htmlFor="v-iss">Token id</Label>
                  <Input id="v-iss" value={issuanceId} onChange={(e) => setIssuanceId(e.target.value.trim())} placeholder="MPT issuance id" className="font-mono text-xs" disabled={!!created} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="v-dec">Decimals</Label>
                <Input id="v-dec" inputMode="numeric" value={decimals} onChange={(e) => setDecimals(e.target.value.trim())} placeholder="2" disabled={!!created} />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="v-sym">Symbol</Label>
                <Input id="v-sym" value={symbol} onChange={(e) => setSymbol(e.target.value.trim())} placeholder="USDX" disabled={!!created} />
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="v-fee">Management fee (%)</Label>
              <Input id="v-fee" inputMode="decimal" value={feePct} onChange={(e) => setFeePct(e.target.value.trim())} disabled={!!created} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-mc">Minimum cover (%)</Label>
              <Input id="v-mc" inputMode="decimal" value={minCoverPct} onChange={(e) => setMinCoverPct(e.target.value.trim())} disabled={!!created} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="v-cov">First-loss cover you fund</Label>
              <Input id="v-cov" inputMode="decimal" value={coverAmt} onChange={(e) => setCoverAmt(e.target.value.trim())} placeholder="0.00" disabled={!!created} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={gated} onChange={(e) => setGated(e.target.checked)} disabled={!!created} /> Restrict deposits to verified accounts
          </label>
          {gated && (
            <div className="space-y-1.5">
              <Label htmlFor="v-ct">Required credential</Label>
              <select id="v-ct" value={credType} onChange={(e) => setCredType(e.target.value)} disabled={!!created} className={sel}>
                {CREDENTIAL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Admit depositors from the vault manager once the market is live.</p>
            </div>
          )}
        </div>
      </Step>

      {needToken && (
        <Step n={stepNo("token")} title="Mint the market token" active={detailsOk && !tokenId} done={!!tokenId}>
          <p className="mb-2 text-xs text-muted-foreground">You are the token issuer, so you keep control of supply.</p>
          <TxButton
            label="Mint token"
            explain={explain}
            disabled={!isConnected || !detailsOk || !!tokenId}
            tx={() => ({
              TransactionType: "MPTokenIssuanceCreate",
              Account: address,
              Flags: MF.tfMPTCanTransfer | MF.tfMPTCanEscrow,
              AssetScale: Number(decimals || 0),
              MaximumAmount: "1000000000000",
              MPTokenMetadata: convertStringToHex(JSON.stringify({ ticker: (symbol || "TKN").toUpperCase().slice(0, 8), name: symbol || "Token", asset_class: "other", issuer_name: name || "Vault" })),
            })}
            onResult={onToken}
          />
        </Step>
      )}

      <Step n={stepNo("vault")} title="Provision the market" active={detailsOk && (!needToken || tokenId) && !created} done={!!created}>
        <p className="mb-2 text-xs text-muted-foreground">
          The desk creates the vault and broker so the market can originate loans. No signature needed from you.
        </p>
        <Button onClick={provision} disabled={!isConnected || !address || !detailsOk || (needToken && !tokenId) || !!created || busy}>
          {busy ? "Creating…" : "Create market"}
        </Button>
      </Step>

      {wantCover && (
        <Step n={stepNo("cover")} title="Fund first-loss cover" active={!!created && !coverDone} done={coverDone}>
          <p className="mb-2 text-xs text-muted-foreground">
            You send {coverAmt} {sym} to the desk, which deposits it as this market’s first-loss cover.
          </p>
          <TxButton
            label={`Fund ${coverAmt} ${sym} cover`}
            explain={explain}
            disabled={!isConnected || !created || coverDone || busy}
            tx={() => ({ TransactionType: "Payment", Account: address, Destination: created.operator || DESK_OPERATOR, Amount: assetAmount(asset, toBaseUnits(asset, coverAmt)) })}
            onResult={onCoverPaid}
          />
        </Step>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Didn’t go through</AlertTitle>
          <AlertDescription className="break-all">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
