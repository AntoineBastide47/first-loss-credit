"use client";

// Managing one market: watch the tranches, maintain cover, work the loan book, control
// access, distribute the market's token, and edit what the ledger lets you edit.
//
// Two roles reach this screen. The on-chain owner signs owner actions directly. The
// creator of a desk-held market cannot sign them, so those go through the desk's server
// routes, which authorise from ledger state (cover is always returned to the creator
// recorded on the vault, and the access gate can only point at that same account).

import { useCallback, useEffect, useRef, useState } from "react";
import { convertStringToHex } from "xrpl";
import { TxButton, explain } from "../lending";
import { marketVault, marketBroker, utilisation } from "../../lib/product";
import { requiredCover, brokerLoans, isSettled, escrowsTo } from "../../lib/lending-read";
import { assetSymbol, formatAmount, toBaseUnits, isPositiveAmount, assetAmount } from "../../lib/asset";
import { formatRippleTime, shortId } from "../../lib/format";
import { addMarket, removeMarket } from "../../lib/market";
import { deskOp, collateralOp } from "../../lib/desk";
import { CopyId } from "../CopyId";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";

const POLL_MS = 8000;
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const LSF_LOAN_DEFAULT = 0x00010000;
const LSF_LOAN_IMPAIRED = 0x00020000;
const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

function statusOf(loan) {
  if (isSettled(loan)) return { label: "Repaid", tone: "text-muted-foreground", settled: true };
  const flags = Number(loan.Flags ?? 0);
  const now = rippleNow();
  const due = Number(loan.NextPaymentDueDate ?? 0);
  const graceEnd = due + Number(loan.GracePeriod ?? 0);
  if ((flags & LSF_LOAN_DEFAULT) !== 0) return { label: "Defaulted", tone: "text-destructive", defaulted: true };
  const impaired = (flags & LSF_LOAN_IMPAIRED) !== 0;
  if (now > graceEnd) return { label: impaired ? "Impaired, in default window" : "In default window", tone: "text-destructive", canDefault: true, impaired };
  if (now > due) return { label: impaired ? "Impaired, overdue" : "Overdue", tone: "text-amber-600", impaired };
  return { label: impaired ? "Impaired" : "On track", tone: impaired ? "text-amber-600" : "text-emerald-600", impaired };
}

export function VaultManager({ market, address, isConnected, onChanged }) {
  const asset = market.asset;
  const sym = assetSymbol(asset);
  const isOwner = address === market.operator;
  const isCreator = !!address && address === market.creator;
  const canManage = isOwner || isCreator;

  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);
  const [loans, setLoans] = useState([]);
  const [collateral, setCollateral] = useState({}); // borrower -> [{seq, amount}]
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");
  const [admit, setAdmit] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [newName, setNewName] = useState("");
  const [newCap, setNewCap] = useState("");
  const [fees, setFees] = useState(null); // { earned, forwarded, claimable }
  const [busy, setBusy] = useState(null); // name of the action in flight
  const [msg, setMsg] = useState(null); // { ok } | { error }

  const load = useCallback(async () => {
    const [v, b] = await Promise.all([marketVault(market).catch(() => null), marketBroker(market).catch(() => null)]);
    setVault(v);
    setBroker(b);
    const list = await brokerLoans(market.brokerId).catch(() => []);
    setLoans(list);
    // Collateral has no on-chain tie to a loan, so look up what each borrower has locked
    // to the desk and show it against their loan.
    const borrowers = [...new Set(list.map((x) => x.loan?.Borrower).filter(Boolean))];
    const found = await Promise.all(borrowers.map((b2) => escrowsTo(b2, market.operator).then((e) => [b2, e]).catch(() => [b2, []])));
    setCollateral(Object.fromEntries(found));
    // What the desk has collected in fees for this market, and what it still owes you.
    if (canManage) {
      deskOp({ op: "fees", brokerId: market.brokerId }).then(setFees).catch(() => setFees(null));
    }
  }, [market, canManage]);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  /** Run a desk action, showing one shared busy/result state. */
  const run = useCallback(async (key, fn) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true });
      load();
      onChanged?.();
    } catch (e) {
      setMsg({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }, [load, onChanged]);

  // The creator is always meant to be the credential issuer; repair it once automatically.
  const repaired = useRef(null);
  useEffect(() => {
    if (!address || !market.gate || !market.domainId) return;
    if (market.gate.issuer === address || market.creator !== address) return;
    if (repaired.current === market.id) return;
    repaired.current = market.id;
    deskOp({ op: "domain", vaultId: market.vaultId, credentialType: convertStringToHex(market.gate.credentialType) })
      .then(() => { addMarket({ ...market, gate: { ...market.gate, issuer: address } }); onChanged?.(); })
      .catch(() => {});
  }, [address, market, onChanged]);

  const deposits = vault ? big(vault.AssetsTotal) : 0n;
  const available = vault ? big(vault.AssetsAvailable) : 0n;
  const lent = deposits - available;
  const cover = broker ? big(broker.CoverAvailable) : 0n;
  const debt = broker ? big(broker.DebtTotal) : 0n;
  const minimum = broker ? requiredCover(broker) : 0n;
  const below = minimum > 0n && cover < minimum;
  const util = vault ? utilisation(vault) : 0;
  const stack = cover + deposits;
  const juniorPct = pct(cover, stack);

  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-semibold">{market.name}</h3>
            <p className="text-xs text-muted-foreground">{sym} denominated{market.gate ? ` · gated (${market.gate.credentialType})` : " · open"}</p>
            <CopyId id={market.vaultId} label="vault" />
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
              <div><p className="text-xs text-muted-foreground">Available</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, available)} {sym}</p></div>
              <div><p className="text-xs text-muted-foreground">Lent out</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, lent)} {sym}</p></div>
              <div><p className="text-xs text-muted-foreground">Utilisation</p><p className="mt-1 font-semibold tabular-nums">{(util * 100).toFixed(0)}%</p></div>
            </div>

            {/* Loss waterfall: junior cover is wiped out before senior deposits are touched. */}
            <div className="mt-4">
              <p className="mb-1 text-xs text-muted-foreground">Loss order: junior cover absorbs first, then lender deposits</p>
              <div className="flex h-6 w-full overflow-hidden rounded-md border border-border/60">
                <div className="flex items-center justify-center bg-emerald-500/30 text-[10px] font-medium" style={{ width: `${juniorPct}%` }} title="first-loss cover">
                  {juniorPct > 12 ? `${formatAmount(asset, cover)} ${sym}` : ""}
                </div>
                <div className="flex flex-1 items-center justify-center bg-sky-500/25 text-[10px] font-medium" title="lender deposits">
                  {formatAmount(asset, deposits)} {sym}
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Cover {formatAmount(asset, cover)} {sym} · minimum {formatAmount(asset, minimum)} {sym} · protecting {formatAmount(asset, debt)} {sym} of loans
              </p>
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
                </div>
              </div>
            ) : isCreator ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor={`add-${market.id}`}>Add cover ({sym})</Label>
                  <Input id={`add-${market.id}`} inputMode="decimal" value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="0.00" />
                  <TxButton
                    label={`Fund ${add || "0"} ${sym}`}
                    explain={explain}
                    disabled={!isConnected || !isPositiveAmount(asset, add) || busy === "fund"}
                    tx={() => ({ TransactionType: "Payment", Account: address, Destination: market.operator, Amount: assetAmount(asset, toBaseUnits(asset, add)) })}
                    onResult={({ code, hash }) => {
                      if (code !== "tesSUCCESS" || !hash) return;
                      run("fund", async () => {
                        await deskOp({ op: "cover", brokerId: market.brokerId, asset, amount: toBaseUnits(asset, add), paymentHash: hash });
                        setAdd("");
                      });
                    }}
                  />
                  <p className="text-xs text-muted-foreground">You pay the desk, which deposits it as this market&apos;s cover.</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`rm-${market.id}`}>Withdraw cover ({sym})</Label>
                  <Input id={`rm-${market.id}`} inputMode="decimal" value={remove} onChange={(e) => setRemove(e.target.value.trim())} placeholder="0.00" />
                  <Button variant="outline" size="sm" disabled={!isPositiveAmount(asset, remove) || busy === "cw"}
                    onClick={() => run("cw", async () => {
                      await deskOp({ op: "coverWithdraw", brokerId: market.brokerId, amount: toBaseUnits(asset, remove) });
                      setRemove("");
                    })}>
                    {busy === "cw" ? "Withdrawing…" : "Withdraw to my wallet"}
                  </Button>
                  <p className="text-xs text-muted-foreground">Paid back to the account recorded as this market&apos;s creator. Can&apos;t drop below the minimum while loans are outstanding.</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">First-loss cover is managed by the account that runs this market.</p>
            )}
            {msg?.error && <p className="mt-2 text-xs text-destructive break-all">{msg.error}</p>}
          </TabsContent>

          <TabsContent value="loans">
            <div className="divide-y divide-border/60">
              {loans.length === 0 && <p className="text-sm text-muted-foreground">No loans in this vault yet.</p>}
              {loans.map(({ id, loan }) => {
                const s = statusOf(loan);
                const locked = (collateral[loan.Borrower] || [])[0];
                return (
                  <div key={id} className="space-y-2 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-medium tabular-nums">{formatAmount(asset, loan.PrincipalOutstanding)} {sym}</span>
                        <span className="text-muted-foreground"> · {loan.PaymentRemaining ?? 0} left · due {formatRippleTime(loan.NextPaymentDueDate)}</span>
                        <span className="block text-xs text-muted-foreground">borrower {shortId(loan.Borrower, 6)}{locked ? " · collateral posted" : ""}</span>
                      </div>
                      <span className={`font-medium ${s.tone}`}>{s.label}</span>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        {!s.settled && !s.defaulted && !s.impaired && (
                          <Button variant="outline" size="sm" disabled={busy === `im-${id}`}
                            onClick={() => run(`im-${id}`, () => deskOp({ op: "loan", loanId: id, action: "impair" }))}>Impair</Button>
                        )}
                        {!s.settled && !s.defaulted && s.impaired && (
                          <Button variant="outline" size="sm" disabled={busy === `un-${id}`}
                            onClick={() => run(`un-${id}`, () => deskOp({ op: "loan", loanId: id, action: "unimpair" }))}>Un-impair</Button>
                        )}
                        {s.canDefault && (
                          <Button variant="outline" size="sm" disabled={busy === `df-${id}`}
                            onClick={() => run(`df-${id}`, () => deskOp({ op: "loan", loanId: id, action: "default" }))}>Default</Button>
                        )}
                        {locked && (
                          <Button variant="outline" size="sm" disabled={busy === `cc-${id}`}
                            onClick={() => run(`cc-${id}`, () => collateralOp({ op: "claim", owner: loan.Borrower, seq: locked.seq, tokenId: locked.amount?.mpt_issuance_id }))}>
                            Claim collateral
                          </Button>
                        )}
                        {s.settled && (
                          <Button variant="outline" size="sm" disabled={busy === `rm-${id}`}
                            onClick={() => run(`rm-${id}`, () => deskOp({ op: "loanDelete", loanId: id }))}>Remove</Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {msg?.error && <p className="mt-2 text-xs text-destructive break-all">{msg.error}</p>}
          </TabsContent>

          <TabsContent value="settings">
            <div className="space-y-5">
              {canManage && (
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
                  <Button variant="outline" size="sm" disabled={busy === "set" || (!newName.trim() && !newCap.trim())}
                    onClick={() => run("set", async () => {
                      const body = { op: "settings", vaultId: market.vaultId };
                      if (newName.trim()) body.name = newName.trim();
                      if (newCap.trim()) body.assetsMaximum = toBaseUnits(asset, newCap.trim());
                      await deskOp(body);
                      if (body.name) addMarket({ ...market, name: body.name });
                      setNewName("");
                      setNewCap("");
                    })}>
                    {busy === "set" ? "Saving…" : "Save vault settings"}
                  </Button>
                  <p className="text-xs text-muted-foreground">The name is stored on the vault itself, so anyone who finds this market sees it. Open vs gated cannot be changed after creation.</p>
                </div>
              )}

              {canManage && asset.kind === "MPT" && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Distribute {sym}</h4>
                  <p className="text-xs text-muted-foreground">Send the market&apos;s token so others can deposit. They opt in on Earn first.</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input value={sendTo} onChange={(e) => setSendTo(e.target.value.trim())} placeholder="r… recipient" className="font-mono text-xs" />
                    <Input inputMode="decimal" value={sendAmt} onChange={(e) => setSendAmt(e.target.value.trim())} placeholder={`0.00 ${sym}`} />
                  </div>
                  <TxButton label={`Send ${sym}`} explain={explain} disabled={!isConnected || !sendTo || !isPositiveAmount(asset, sendAmt)}
                    tx={() => ({ TransactionType: "Payment", Account: address, Destination: sendTo, Amount: assetAmount(asset, toBaseUnits(asset, sendAmt)) })}
                    onResult={() => { setSendTo(""); setSendAmt(""); }} />
                </div>
              )}

              {canManage && fees && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Fees earned</h4>
                  <div className="grid grid-cols-3 gap-4">
                    <div><p className="text-xs text-muted-foreground">Collected</p><p className="font-medium tabular-nums">{formatAmount(asset, fees.earned)} {sym}</p></div>
                    <div><p className="text-xs text-muted-foreground">Already paid out</p><p className="font-medium tabular-nums">{formatAmount(asset, fees.forwarded)} {sym}</p></div>
                    <div><p className="text-xs text-muted-foreground">Owed to you</p><p className="font-medium tabular-nums text-emerald-600">{formatAmount(asset, fees.claimable)} {sym}</p></div>
                  </div>
                  <Button variant="outline" size="sm" disabled={busy === "fees" || !fees.claimable || fees.claimable === "0"}
                    onClick={() => run("fees", () => deskOp({ op: "feesWithdraw", brokerId: market.brokerId }))}>
                    {busy === "fees" ? "Sending…" : "Send fees to my wallet"}
                  </Button>
                  <p className="text-xs text-muted-foreground">Borrowers pay the management fee to the desk, which holds every market&apos;s fees together. The split is worked out from the ledger and paid to the account recorded as this market&apos;s creator.</p>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Broker terms</h4>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div><p className="text-xs text-muted-foreground">Management fee</p><p className="font-medium tabular-nums">{(Number(broker?.ManagementFeeRate ?? 0) / 1000).toFixed(2)}%</p></div>
                  <div><p className="text-xs text-muted-foreground">Minimum cover</p><p className="font-medium tabular-nums">{(Number(broker?.CoverRateMinimum ?? 0) / 1000).toFixed(1)}%</p></div>
                  <div><p className="text-xs text-muted-foreground">Liquidation rate</p><p className="font-medium tabular-nums">{(Number(broker?.CoverRateLiquidation ?? 0) / 1000).toFixed(1)}%</p></div>
                </div>
                <p className="text-xs text-muted-foreground">Broker terms are fixed when the vault is created.</p>
              </div>

              {market.gate && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Access</h4>
                  <p className="text-xs text-muted-foreground">
                    Deposits need a {market.gate.credentialType} credential issued by{" "}
                    {address === market.gate.issuer ? "you" : <span className="font-mono">{shortId(market.gate.issuer, 8)}</span>}. Depositors accept it on Earn.
                  </p>
                  {address && address !== market.gate.issuer && (
                    <Button variant="outline" size="sm" disabled={busy === "dom"}
                      onClick={() => run("dom", async () => {
                        await deskOp({ op: "domain", vaultId: market.vaultId, credentialType: convertStringToHex(market.gate.credentialType) });
                        addMarket({ ...market, gate: { ...market.gate, issuer: market.creator || address } });
                      })}>
                      {busy === "dom" ? "Updating…" : "Point the gate at the creator"}
                    </Button>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Input value={admit} onChange={(e) => setAdmit(e.target.value.trim())} placeholder="r… depositor address" className="font-mono text-xs sm:max-w-xs" />
                    <TxButton label="Issue credential" explain={explain} disabled={!isConnected || !admit}
                      tx={() => ({ TransactionType: "CredentialCreate", Account: address, Subject: admit, CredentialType: convertStringToHex(market.gate.credentialType) })}
                      onResult={() => setAdmit("")} />
                    <TxButton label="Revoke" variant="outline" explain={explain} disabled={!isConnected || !admit || address !== market.gate.issuer}
                      tx={() => ({ TransactionType: "CredentialDelete", Account: address, Subject: admit, Issuer: address, CredentialType: convertStringToHex(market.gate.credentialType) })}
                      onResult={() => setAdmit("")} />
                  </div>
                  <p className="text-xs text-muted-foreground">Revoking removes the credential, so that account can no longer deposit.</p>
                </div>
              )}

              {canManage && (
                <div className="space-y-2">
                  <h4 className="text-sm font-medium">Close this market</h4>
                  <p className="text-xs text-muted-foreground">Deletes the broker and vault on the ledger and frees their reserves. Only possible once every loan is settled, the cover is withdrawn and all deposits are out.</p>
                  <Button variant="outline" size="sm" disabled={busy === "close"}
                    onClick={() => run("close", () => deskOp({ op: "close", vaultId: market.vaultId, brokerId: market.brokerId }))}>
                    {busy === "close" ? "Closing…" : "Close market"}
                  </Button>
                </div>
              )}

              <div className="space-y-2">
                <h4 className="text-sm font-medium">Remove from this browser</h4>
                <p className="text-xs text-muted-foreground">Forgets the market locally. The vault stays on the ledger and is still discoverable.</p>
                <Button variant="outline" size="sm" onClick={() => { removeMarket(market.id); onChanged?.(); }}>Forget market</Button>
              </div>

              {msg?.ok && <p className="text-xs text-emerald-600">Done.</p>}
              {msg?.error && <p className="text-xs text-destructive break-all">{msg.error}</p>}
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
