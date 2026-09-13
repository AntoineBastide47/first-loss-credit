"use client";

// Owner view of one vault: maintain cover, edit broker terms, work the loan book, admit
// depositors to a gated vault, and drop a custom market from this browser. Reads live.

import { useCallback, useEffect, useRef, useState } from "react";
import { convertStringToHex, LoanManageFlags } from "xrpl";
import { TxButton, explain } from "../lending";
import { marketVault, marketBroker, utilisation } from "../../lib/product";
import { requiredCover, brokerLoans, isSettled } from "../../lib/lending-read";
import { assetSymbol, formatAmount, toBaseUnits, isPositiveAmount, assetAmount } from "../../lib/asset";
import { formatRippleTime, shortId } from "../../lib/format";
import { addMarket, removeMarket } from "../../lib/market";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";

const POLL_MS = 8000;
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const LSF_LOAN_DEFAULT = 0x00010000;

function statusOf(loan) {
  if (isSettled(loan)) return { label: "Repaid", tone: "text-muted-foreground" };
  const now = rippleNow();
  const due = Number(loan.NextPaymentDueDate ?? 0);
  const graceEnd = due + Number(loan.GracePeriod ?? 0);
  if ((Number(loan.Flags) & LSF_LOAN_DEFAULT) !== 0) return { label: "Defaulted", tone: "text-destructive" };
  if (now > graceEnd) return { label: "In default window", tone: "text-destructive", canDefault: true };
  if (now > due) return { label: "Overdue", tone: "text-amber-600" };
  return { label: "On track", tone: "text-emerald-600" };
}

export function VaultManager({ market, address, isConnected, onChanged }) {
  const asset = market.asset;
  const sym = assetSymbol(asset);
  const custom = market.id.startsWith("user-");
  // The on-chain owner signs owner actions directly. A creator whose market the desk
  // holds funds cover by paying the desk, which deposits it (a non-owner cover deposit
  // is rejected with tecNO_PERMISSION).
  const isOwner = address === market.operator;
  const isCreator = !isOwner && address && address === market.creator;
  const [fundBusy, setFundBusy] = useState(false);
  const [fundError, setFundError] = useState(null);
  const [issuerBusy, setIssuerBusy] = useState(false);
  const [issuerError, setIssuerError] = useState(null);
  const [newName, setNewName] = useState("");
  const [newCap, setNewCap] = useState("");
  const [setBusy, setSetBusy] = useState(false);
  const [setMsg, setSetMsg] = useState(null);

  // Point the vault's access domain at your wallet so credentials you issue are the ones
  // that admit depositors. The desk owns the domain and PermissionedDomainSet updates it
  // in place, so the vault honours the new issuer immediately.
  const claimIssuer = useCallback(async () => {
    setIssuerBusy(true);
    setIssuerError(null);
    try {
      const r = await fetch("/api/vault", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ op: "domain", domainId: market.domainId, issuer: address, credentialType: convertStringToHex(market.gate.credentialType) }),
      });
      const d = await r.json();
      if (d.code === "tesSUCCESS") {
        addMarket({ ...market, gate: { ...market.gate, issuer: address } });
        onChanged?.();
      } else {
        setIssuerError(d.error || `Could not update access (${d.code}).`);
      }
    } catch (e) {
      setIssuerError(e instanceof Error ? e.message : String(e));
    } finally {
      setIssuerBusy(false);
    }
  }, [market, address, onChanged]);

  // VaultSet is the one post-creation editor the ledger offers: the on-chain name (Data)
  // and the deposit cap (AssetsMaximum). It is owner-only, so the desk signs it.
  const saveSettings = useCallback(async () => {
    setSetBusy(true);
    setSetMsg(null);
    try {
      const body = { op: "settings", vaultId: market.vaultId };
      if (newName.trim()) body.name = newName.trim();
      if (newCap.trim()) body.assetsMaximum = toBaseUnits(asset, newCap.trim());
      const r = await fetch("/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (d.code === "tesSUCCESS") {
        if (body.name) addMarket({ ...market, name: body.name });
        setNewName("");
        setNewCap("");
        setSetMsg({ ok: true });
        load();
        onChanged?.();
      } else {
        setSetMsg({ error: d.error || `Could not save (${d.code}).` });
      }
    } catch (e) {
      setSetMsg({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSetBusy(false);
    }
  }, [market, newName, newCap, asset, onChanged]);

  // The creator is always meant to be the credential issuer. If a vault ended up trusting
  // someone else, repair it once rather than making the creator click a button.
  const repaired = useRef(null);
  useEffect(() => {
    if (!address || !market.gate || !market.domainId) return;
    if (market.gate.issuer === address || market.creator !== address) return;
    if (repaired.current === market.id) return;
    repaired.current = market.id;
    claimIssuer();
  }, [address, market, claimIssuer]);

  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);
  const [loans, setLoans] = useState([]);
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  const [admit, setAdmit] = useState("");

  const load = useCallback(async () => {
    const [v, b] = await Promise.all([marketVault(market).catch(() => null), marketBroker(market).catch(() => null)]);
    setVault(v);
    setBroker(b);
    setLoans(await brokerLoans(market.brokerId).catch(() => []));
  }, [market]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const deposits = vault ? big(vault.AssetsTotal) : 0n;
  const available = vault ? big(vault.AssetsAvailable) : 0n;
  const lent = deposits - available;
  const cover = broker ? big(broker.CoverAvailable) : 0n;
  const debt = broker ? big(broker.DebtTotal) : 0n;
  const minimum = broker ? requiredCover(broker) : 0n;
  const below = minimum > 0n && cover < minimum;
  const util = vault ? utilisation(vault) : 0;
  const coverFill = minimum > 0n ? Math.min(100, Number((cover * 100n) / (minimum > cover ? minimum : cover || 1n))) : cover > 0n ? 100 : 0;

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">{market.name}</h3>
            <p className="text-xs text-muted-foreground">{sym} denominated{market.gate ? ` · gated (${market.gate.credentialType})` : ""}</p>
          </div>
          <span className={`text-sm ${below ? "text-destructive" : "text-emerald-600"}`}>{minimum === 0n ? "No loans" : below ? "Cover below minimum" : "Healthy"}</span>
        </div>

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="cover">Cover</TabsTrigger>
            <TabsTrigger value="loans">Loans</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Deposits</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, deposits)} {sym}</p></div>
              <div><p className="text-xs text-muted-foreground">Lent out</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, lent)} {sym}</p></div>
              <div><p className="text-xs text-muted-foreground">Cover</p><p className={`mt-1 font-semibold tabular-nums ${below ? "text-destructive" : "text-emerald-600"}`}>{formatAmount(asset, cover)} {sym}</p></div>
              <div><p className="text-xs text-muted-foreground">Utilisation</p><p className="mt-1 font-semibold tabular-nums">{(util * 100).toFixed(0)}%</p></div>
            </div>
            <div className="mt-3">
              <p className="mb-1 text-xs text-muted-foreground">First-loss cover vs minimum</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${below ? "bg-destructive" : "bg-emerald-500"}`} style={{ width: `${coverFill}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Minimum now: {formatAmount(asset, minimum)} {sym} · protecting {formatAmount(asset, debt)} {sym} of loans</p>
            </div>
          </TabsContent>

          <TabsContent value="cover">
            {isOwner ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`add-${market.id}`}>Add cover ({sym})</Label>
                  <Input id={`add-${market.id}`} inputMode="decimal" value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="0.00" />
                  <TxButton label="Add cover" explain={explain} disabled={!isConnected || !isPositiveAmount(asset, add)}
                    tx={() => ({ TransactionType: "LoanBrokerCoverDeposit", Account: address, LoanBrokerID: market.brokerId, Amount: assetAmount(asset, toBaseUnits(asset, add)) })}
                    onResult={() => { setAdd(""); load(); }} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`rm-${market.id}`}>Withdraw cover ({sym})</Label>
                  <Input id={`rm-${market.id}`} inputMode="decimal" value={remove} onChange={(e) => setRemove(e.target.value.trim())} placeholder="0.00" />
                  <TxButton label="Withdraw" variant="outline" explain={explain} disabled={!isConnected || !isPositiveAmount(asset, remove)}
                    tx={() => ({ TransactionType: "LoanBrokerCoverWithdraw", Account: address, LoanBrokerID: market.brokerId, Amount: assetAmount(asset, toBaseUnits(asset, remove)) })}
                    onResult={() => { setRemove(""); load(); }} />
                  <p className="text-xs text-muted-foreground">Can’t drop below the minimum while loans are outstanding.</p>
                </div>
              </div>
            ) : isCreator ? (
              <div className="space-y-2 sm:max-w-sm">
                <Label htmlFor={`add-${market.id}`}>Add cover ({sym})</Label>
                <Input id={`add-${market.id}`} inputMode="decimal" value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="0.00" />
                <TxButton
                  label={`Fund ${add || "0"} ${sym} cover`}
                  explain={explain}
                  disabled={!isConnected || !isPositiveAmount(asset, add) || fundBusy}
                  tx={() => ({ TransactionType: "Payment", Account: address, Destination: market.operator, Amount: assetAmount(asset, toBaseUnits(asset, add)) })}
                  onResult={async ({ code, hash }) => {
                    if (code !== "tesSUCCESS" || !hash) return;
                    setFundBusy(true);
                    setFundError(null);
                    try {
                      const r = await fetch("/api/vault", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ op: "cover", brokerId: market.brokerId, asset, amount: toBaseUnits(asset, add), paymentHash: hash }),
                      });
                      const d = await r.json();
                      if (d.code === "tesSUCCESS") { setAdd(""); load(); }
                      else setFundError(d.error || "Cover deposit failed.");
                    } catch (e) {
                      setFundError(e instanceof Error ? e.message : String(e));
                    } finally {
                      setFundBusy(false);
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">You send the cover to the desk, which deposits it into this market. Withdrawing cover is a desk action.</p>
                {fundError && <p className="text-xs text-destructive break-all">{fundError}</p>}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">First-loss cover is managed by the account that runs this market.</p>
            )}
          </TabsContent>

          <TabsContent value="loans">
            <div className="divide-y divide-border/60">
              {loans.length === 0 && <p className="text-sm text-muted-foreground">No loans in this vault yet.</p>}
              {loans.map(({ id, loan }) => {
                const s = statusOf(loan);
                return (
                  <div key={id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div>
                      <span className="font-medium tabular-nums">{formatAmount(asset, loan.PrincipalOutstanding)} {sym}</span>
                      <span className="text-muted-foreground"> · {loan.PaymentRemaining ?? 0} left · due {formatRippleTime(loan.NextPaymentDueDate)}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`font-medium ${s.tone}`}>{s.label}</span>
                      {s.canDefault && isOwner && (
                        <TxButton label="Default" variant="outline" explain={explain} disabled={!isConnected}
                          tx={() => ({ TransactionType: "LoanManage", Account: address, LoanID: id, Flags: LoanManageFlags.tfLoanDefault })}
                          onResult={load} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </TabsContent>

          <TabsContent value="settings">
            <div className="space-y-5">
              {(isOwner || isCreator) && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Vault settings</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={`nm-${market.id}`}>Name</Label>
                      <Input id={`nm-${market.id}`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={market.name} />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`cap-${market.id}`}>Deposit cap ({sym})</Label>
                      <Input id={`cap-${market.id}`} inputMode="decimal" value={newCap} onChange={(e) => setNewCap(e.target.value.trim())}
                        placeholder={vault?.AssetsMaximum ? formatAmount(asset, vault.AssetsMaximum) : "no cap"} />
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={saveSettings} disabled={setBusy || (!newName.trim() && !newCap.trim())}>
                    {setBusy ? "Saving…" : "Save vault settings"}
                  </Button>
                  {setMsg?.ok && <p className="text-xs text-emerald-600">Saved on-ledger.</p>}
                  {setMsg?.error && <p className="text-xs text-destructive break-all">{setMsg.error}</p>}
                  <p className="text-xs text-muted-foreground">The name is stored on the vault itself, so anyone who finds this market sees it. Open vs gated cannot be changed after creation.</p>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Broker terms</h4>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div><p className="text-xs text-muted-foreground">Management fee</p><p className="font-medium tabular-nums">{(Number(broker?.ManagementFeeRate ?? 0) / 1000).toFixed(2)}%</p></div>
                  <div><p className="text-xs text-muted-foreground">Minimum cover</p><p className="font-medium tabular-nums">{(Number(broker?.CoverRateMinimum ?? 0) / 1000).toFixed(1)}%</p></div>
                  <div><p className="text-xs text-muted-foreground">Liquidation rate</p><p className="font-medium tabular-nums">{(Number(broker?.CoverRateLiquidation ?? 0) / 1000).toFixed(1)}%</p></div>
                </div>
                <p className="text-xs text-muted-foreground">Broker terms are fixed when the vault is created. Adjust protection by adding or withdrawing cover.</p>
              </div>

              {market.gate && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Access</h4>
                  <p className="text-xs text-muted-foreground">
                    Deposits need a {market.gate.credentialType} credential issued by{" "}
                    {address === market.gate.issuer ? "you" : <span className="font-mono">{shortId(market.gate.issuer, 8)}</span>}.
                    {" "}Depositors accept it on Earn.
                  </p>
                  {address && address !== market.gate.issuer && market.domainId && (
                    <div className="space-y-1">
                      <Button variant="outline" size="sm" onClick={claimIssuer} disabled={!isConnected || issuerBusy}>
                        {issuerBusy ? "Updating…" : "Make my wallet the issuer"}
                      </Button>
                      <p className="text-xs text-muted-foreground">Credentials you issue only work once this vault trusts your wallet.</p>
                      {issuerError && <p className="text-xs text-destructive break-all">{issuerError}</p>}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Input value={admit} onChange={(e) => setAdmit(e.target.value.trim())} placeholder="r… depositor address" className="font-mono text-xs sm:max-w-xs" />
                    <TxButton label="Issue credential" explain={explain} disabled={!isConnected || !admit}
                      tx={() => ({ TransactionType: "CredentialCreate", Account: address, Subject: admit, CredentialType: convertStringToHex(market.gate.credentialType) })}
                      onResult={() => setAdmit("")} />
                  </div>
                </div>
              )}

              {custom && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Remove from this browser</h4>
                  <p className="text-xs text-muted-foreground">Forgets the market locally. The vault stays on the ledger.</p>
                  <Button variant="outline" size="sm" onClick={() => { removeMarket(market.id); onChanged?.(); }}>Forget market</Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
