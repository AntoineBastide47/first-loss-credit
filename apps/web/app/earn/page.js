"use client";

// Earn: deposit XRP into the First-Loss Credit Vault and earn yield from borrower
// interest, protected by junior first-loss cover. Human XRP throughout; no ledger ids.

import { useCallback, useEffect, useRef, useState } from "react";
import { xrpToDrops } from "xrpl";
import { Header } from "../../components/Header";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKET } from "../../lib/market";
import { marketVault, marketBroker, myShares, utilisation, loadBasis, saveBasis, redeemableAssets } from "../../lib/product";
import { formatDrops, groupThousands } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

const POLL_MS = 6000;
const xrp = (drops) => groupThousands(formatDrops(String(drops ?? "0")));
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

  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);
  const [shares, setShares] = useState("0");
  const [depositXrp, setDepositXrp] = useState("");
  const [withdrawXrp, setWithdrawXrp] = useState("");
  const depositRef = useRef("0");
  const beforeSharesRef = useRef("0");

  const load = useCallback(async () => {
    const [v, b, s] = await Promise.all([marketVault(), marketBroker().catch(() => null), myShares(address)]);
    setVault(v);
    setBroker(b);
    setShares(s);
    return { v, s };
  }, [address]);

  useEffect(() => {
    let on = true;
    const tick = () => load().catch(() => {});
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      on = false;
      clearInterval(id);
      void on;
    };
  }, [load]);

  const sharesBig = big(shares);
  const balanceDrops = vault ? redeemableAssets(vault, sharesBig) : 0n;
  const basis = address ? loadBasis(address) : 0n;
  // Cost basis is tracked in this browser only. Without a record (deposit made on
  // another device, or storage cleared) earnings are unknown, not "all profit".
  const hasBasis = basis > 0n;
  const earnings = balanceDrops - basis;
  const returnPct = hasBasis ? Number((earnings * 10000n) / basis) / 100 : null;

  const tvl = vault ? big(vault.AssetsTotal) : 0n;
  const util = vault ? utilisation(vault) : 0;
  const protection = broker ? big(broker.CoverAvailable) : null;

  const balance = big(balanceDrops);
  const withdrawIsMax = withdrawXrp && vault && (() => {
    try { return big(xrpToDrops(withdrawXrp)) >= balance; } catch { return false; }
  })();

  const depositValid = (() => { try { return depositXrp && big(xrpToDrops(depositXrp)) > 0n; } catch { return false; } })();
  const withdrawValid = (() => { try { return withdrawXrp && big(xrpToDrops(withdrawXrp)) > 0n && balance > 0n; } catch { return false; } })();

  const onDeposit = useCallback(({ code }) => {
    if (code === "tesSUCCESS" && address) {
      try { saveBasis(address, loadBasis(address) + big(xrpToDrops(depositRef.current))); } catch { /* ignore */ }
      setDepositXrp("");
    }
    load();
  }, [address, load]);

  const onWithdraw = useCallback(async ({ code }) => {
    const { s } = await load();
    if (code === "tesSUCCESS" && address) {
      const after = big(s);
      const before = big(beforeSharesRef.current);
      if (after === 0n) saveBasis(address, 0n);
      else if (before > after) saveBasis(address, loadBasis(address) - (loadBasis(address) * (before - after)) / before);
      setWithdrawXrp("");
    }
  }, [address, load]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Earn on your XRP</h1>
            <p className="mt-1 text-muted-foreground">
              Deposit into the {MARKET.name}. Your XRP is lent to vetted borrowers; you earn their
              interest. A junior first-loss layer absorbs losses before you.
            </p>
          </div>

          <Card>
            <CardContent className="grid grid-cols-3 gap-4 p-6">
              <Stat label="Total deposited" value={`${xrp(tvl)} XRP`} />
              <Stat label="Lent out" value={`${(util * 100).toFixed(0)}%`} />
              <Stat label="First-loss protection" value={protection != null ? `${xrp(protection)} XRP` : "—"} accent="text-emerald-600" />
            </CardContent>
          </Card>

          {isConnected && (
            <Card>
              <CardContent className="grid grid-cols-3 gap-4 p-6">
                <Stat label="Your balance" value={`${xrp(balanceDrops)} XRP`} />
                <Stat label="Deposited" value={hasBasis ? `${xrp(basis)} XRP` : "—"} />
                <Stat
                  label="Earnings"
                  value={hasBasis ? `${earnings < 0n ? "-" : "+"}${xrp(earnings < 0n ? -earnings : earnings)} XRP` : "—"}
                  accent={hasBasis && earnings > 0n ? "text-emerald-600" : ""}
                />
                {returnPct != null && (
                  <p className="col-span-3 -mt-2 text-xs text-muted-foreground">
                    {returnPct >= 0 ? "+" : ""}{returnPct.toFixed(2)}% since you deposited
                  </p>
                )}
                {!hasBasis && balance > 0n && (
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
                  <Label htmlFor="dep">Amount (XRP)</Label>
                  <Input id="dep" inputMode="decimal" value={depositXrp} onChange={(e) => setDepositXrp(e.target.value.trim())} placeholder="0.00" />
                </div>
                <TxButton
                  label="Deposit"
                  explain={explain}
                  disabled={!isConnected || !depositValid}
                  tx={() => {
                    depositRef.current = depositXrp;
                    return { TransactionType: "VaultDeposit", Account: address, VaultID: MARKET.vaultId, Amount: xrpToDrops(depositXrp) };
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
                  {balance > 0n && (
                    <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setWithdrawXrp(formatDrops(balance.toString()))}>
                      Max ({xrp(balanceDrops)} XRP)
                    </button>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="wd">Amount (XRP)</Label>
                  <Input id="wd" inputMode="decimal" value={withdrawXrp} onChange={(e) => setWithdrawXrp(e.target.value.trim())} placeholder="0.00" />
                </div>
                <TxButton
                  label={withdrawIsMax ? "Withdraw all" : "Withdraw"}
                  variant="outline"
                  explain={explain}
                  disabled={!isConnected || !withdrawValid}
                  tx={() => {
                    beforeSharesRef.current = shares;
                    // Full exit redeems all shares (principal + earnings); a partial
                    // amount withdraws that many XRP and leaves the rest earning.
                    return withdrawIsMax
                      ? { TransactionType: "VaultWithdraw", Account: address, VaultID: MARKET.vaultId, Amount: { mpt_issuance_id: MARKET.shareMptId, value: shares } }
                      : { TransactionType: "VaultWithdraw", Account: address, VaultID: MARKET.vaultId, Amount: xrpToDrops(withdrawXrp) };
                  }}
                  onResult={onWithdraw}
                />
              </CardContent>
            </Card>
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Yield is variable and comes from borrower interest. Withdrawals depend on available
            liquidity; if the vault is fully lent, wait for repayments.
          </p>
        </div>
      </main>
    </div>
  );
}
