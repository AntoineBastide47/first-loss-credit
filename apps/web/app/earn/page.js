"use client";

// Earn: deposit into a credit vault (XRP or an MPT-denominated one) and earn yield from
// borrower interest, protected by junior first-loss cover. Amounts follow the market's
// asset; no ledger ids.

import { useCallback, useEffect, useRef, useState } from "react";
import { convertStringToHex } from "xrpl";
import { MarketSelect } from "../../components/MarketSelect";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKETS } from "../../lib/market";
import { marketVault, marketBroker, myShares, utilisation, loadBasis, saveBasis, redeemableAssets } from "../../lib/product";
import { assetSymbol, formatAmount, toBaseUnits, isPositiveAmount, assetAmount, shareAmount } from "../../lib/asset";
import { readCredential, isAccepted } from "../../lib/access-read";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";

const POLL_MS = 6000;
const big = (v) => BigInt(v ?? "0");

function Stat({ label, value, accent }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${accent || ""}`}>{value}</p>
    </div>
  );
}

export default function EarnPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [market, setMarket] = useState(MARKETS[0]);
  const asset = market.asset;
  const sym = assetSymbol(asset);

  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);
  const [shares, setShares] = useState("0");
  const [depositAmt, setDepositAmt] = useState("");
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [access, setAccess] = useState("na"); // na | verified | pending | none
  const [demoVerified, setDemoVerified] = useState(false); // demo shortcut, UI only
  const depositRef = useRef("0");
  const beforeSharesRef = useRef("0");

  // Gated vaults only admit holders of an accepted credential from the vault's issuer.
  const gate = market.gate;
  const checkAccess = useCallback(async () => {
    if (!gate || !address) { setAccess("na"); return; }
    try {
      const c = await readCredential({ issuer: gate.issuer, subject: address, credentialType: convertStringToHex(gate.credentialType) });
      setAccess(c && isAccepted(c) ? "verified" : c ? "pending" : "none");
    } catch {
      setAccess("none");
    }
  }, [gate, address]);
  useEffect(() => { checkAccess(); }, [checkAccess]);
  // Drop the demo override whenever the market or the connected account changes.
  useEffect(() => { setDemoVerified(false); }, [market.id, address]);
  const admitted = access === "na" || access === "verified" || demoVerified;

  const load = useCallback(async () => {
    const [v, b, s] = await Promise.all([marketVault(market), marketBroker(market).catch(() => null), myShares(market, address)]);
    setVault(v);
    setBroker(b);
    setShares(s);
    return { v, s };
  }, [market, address]);

  useEffect(() => {
    setVault(null);
    setBroker(null);
    setShares("0");
    const tick = () => load().catch(() => {});
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const sharesBig = big(shares);
  const balanceBase = vault ? redeemableAssets(vault, sharesBig) : 0n;
  const basis = address ? loadBasis(market, address) : 0n;
  const hasBasis = basis > 0n;
  const earnings = balanceBase - basis;
  const returnPct = hasBasis ? Number((earnings * 10000n) / basis) / 100 : null;

  const tvl = vault ? big(vault.AssetsTotal) : 0n;
  const util = vault ? utilisation(vault) : 0;
  const protection = broker ? big(broker.CoverAvailable) : null;

  // Idle assets are the real withdrawal ceiling: anything lent out cannot be redeemed
  // until borrowers repay, and first-loss cover is the broker's capital, not the pool's.
  const availableBase = vault ? big(vault.AssetsAvailable) : 0n;
  const maxWithdraw = balanceBase < availableBase ? balanceBase : availableBase;
  const requested = (() => {
    try { return withdrawAmt ? BigInt(toBaseUnits(asset, withdrawAmt)) : 0n; } catch { return 0n; }
  })();
  const overAvailable = requested > availableBase;
  const overBalance = requested > balanceBase;

  const withdrawIsMax = requested > 0n && requested >= balanceBase && balanceBase > 0n && balanceBase <= availableBase;

  const depositValid = isPositiveAmount(asset, depositAmt);
  const withdrawValid = isPositiveAmount(asset, withdrawAmt) && balanceBase > 0n && !overAvailable && !overBalance;

  const onDeposit = useCallback(({ code }) => {
    if (code === "tesSUCCESS" && address) {
      try { saveBasis(market, address, loadBasis(market, address) + BigInt(toBaseUnits(asset, depositRef.current))); } catch { /* ignore */ }
      setDepositAmt("");
    }
    load();
  }, [market, asset, address, load]);

  const onWithdraw = useCallback(async ({ code }) => {
    const { s } = await load();
    if (code === "tesSUCCESS" && address) {
      const after = big(s);
      const before = big(beforeSharesRef.current);
      if (after === 0n) saveBasis(market, address, 0n);
      else if (before > after) saveBasis(market, address, loadBasis(market, address) - (loadBasis(market, address) * (before - after)) / before);
      setWithdrawAmt("");
    }
  }, [market, address, load]);

  return (
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Earn on your {sym}</h1>
            <p className="mt-1 text-muted-foreground">
              Deposit into the {market.name}. Your {sym} is lent to vetted borrowers; you earn their
              interest. A junior first-loss layer absorbs losses before you.
            </p>
          </div>

          <MarketSelect value={market} onChange={setMarket} />

          {gate && access !== "verified" && (
            <Alert variant={access === "pending" ? "warning" : "default"}>
              <AlertTitle>Verified access required</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>This vault only admits holders of a {gate.credentialType} credential from its issuer.</p>
                {access === "pending" ? (
                  <TxButton
                    label="Accept credential"
                    explain={explain}
                    disabled={!isConnected}
                    tx={() => ({ TransactionType: "CredentialAccept", Account: address, Issuer: gate.issuer, CredentialType: convertStringToHex(gate.credentialType) })}
                    onResult={checkAccess}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">Ask the vault owner to issue you the credential, then accept it here.</p>
                )}
                <Button variant="secondary" size="sm" onClick={() => setDemoVerified(true)}>Verify</Button>
              </AlertDescription>
            </Alert>
          )}

          <Card>
            <CardContent className="grid grid-cols-2 gap-4 p-6 sm:grid-cols-4">
              <Stat label="Total deposited" value={`${formatAmount(asset, tvl)} ${sym}`} />
              <Stat label="Available now" value={`${formatAmount(asset, availableBase)} ${sym}`} />
              <Stat label="Lent out" value={`${(util * 100).toFixed(0)}%`} />
              <Stat label="First-loss protection" value={protection != null ? `${formatAmount(asset, protection)} ${sym}` : "—"} accent="text-emerald-600" />
            </CardContent>
          </Card>

          {isConnected && (
            <Card>
              <CardContent className="grid grid-cols-3 gap-4 p-6">
                <Stat label="Your balance" value={`${formatAmount(asset, balanceBase)} ${sym}`} />
                <Stat label="Deposited" value={hasBasis ? `${formatAmount(asset, basis)} ${sym}` : "—"} />
                <Stat
                  label="Earnings"
                  value={hasBasis ? `${earnings < 0n ? "-" : "+"}${formatAmount(asset, earnings < 0n ? -earnings : earnings)} ${sym}` : "—"}
                  accent={hasBasis && earnings > 0n ? "text-emerald-600" : ""}
                />
                {returnPct != null && (
                  <p className="col-span-3 -mt-2 text-xs text-muted-foreground">
                    {returnPct >= 0 ? "+" : ""}{returnPct.toFixed(2)}% since you deposited
                  </p>
                )}
                {!hasBasis && balanceBase > 0n && (
                  <p className="col-span-3 -mt-2 text-xs text-muted-foreground">
                    Earnings track deposits made on this device. Open the app where you deposited to
                    see them.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 sm:grid-cols-2">
            <Card>
              <CardContent className="space-y-3 p-6">
                <h2 className="font-medium">Deposit</h2>
                <div className="space-y-1.5">
                  <Label htmlFor="dep">Amount ({sym})</Label>
                  <Input id="dep" inputMode="decimal" value={depositAmt} onChange={(e) => setDepositAmt(e.target.value.trim())} placeholder="0.00" />
                </div>
                <TxButton
                  label="Deposit"
                  explain={explain}
                  disabled={!isConnected || !depositValid || !admitted}
                  tx={() => {
                    depositRef.current = depositAmt;
                    return { TransactionType: "VaultDeposit", Account: address, VaultID: market.vaultId, Amount: assetAmount(asset, toBaseUnits(asset, depositAmt)) };
                  }}
                  onResult={onDeposit}
                />
                {!isConnected && <p className="text-xs text-muted-foreground">Connect a wallet to deposit.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-3 p-6">
                <div className="flex items-center justify-between">
                  <h2 className="font-medium">Withdraw</h2>
                  {maxWithdraw > 0n && (
                    <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setWithdrawAmt(formatAmount(asset, maxWithdraw).replace(/,/g, ""))}>
                      Max ({formatAmount(asset, maxWithdraw)} {sym})
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wd">Amount ({sym})</Label>
                  <Input id="wd" inputMode="decimal" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value.trim())} placeholder="0.00" />
                </div>
                <TxButton
                  label={withdrawIsMax ? "Withdraw all" : "Withdraw"}
                  variant="outline"
                  explain={explain}
                  disabled={!isConnected || !withdrawValid}
                  tx={() => {
                    beforeSharesRef.current = shares;
                    // Full exit redeems all shares (principal + earnings); a partial
                    // amount withdraws that many asset units and leaves the rest earning.
                    return withdrawIsMax
                      ? { TransactionType: "VaultWithdraw", Account: address, VaultID: market.vaultId, Amount: shareAmount(market.shareMptId, shares) }
                      : { TransactionType: "VaultWithdraw", Account: address, VaultID: market.vaultId, Amount: assetAmount(asset, toBaseUnits(asset, withdrawAmt)) };
                  }}
                  onResult={onWithdraw}
                />
                {overBalance && <p className="text-xs text-destructive">That is more than your balance.</p>}
                {!overBalance && overAvailable && (
                  <p className="text-xs text-destructive">
                    Only {formatAmount(asset, availableBase)} {sym} is available right now; the rest is lent out and frees up as borrowers repay.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Yield is variable and comes from borrower interest. Withdrawals depend on available
            liquidity; if the vault is fully lent, wait for repayments.
          </p>
        </div>
  );
}
