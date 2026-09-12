"use client";

// Cover: the junior first-loss capital that protects lenders. Add or withdraw cover
// (desk only) and watch the protection health. Amounts follow the market's asset.

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { MarketSelect } from "../../components/MarketSelect";
import { TxButton, explain } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKETS } from "../../lib/market";
import { marketBroker } from "../../lib/product";
import { requiredCover } from "../../lib/lending-read";
import { assetSymbol, formatAmount, toBaseUnits, isPositiveAmount, assetAmount } from "../../lib/asset";
import { Card, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";

const POLL_MS = 6000;
const big = (v) => BigInt(v ?? "0");

export default function CoverPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [market, setMarket] = useState(MARKETS[0]);
  const asset = market.asset;
  const sym = assetSymbol(asset);
  const isOperator = address === market.operator;

  const [broker, setBroker] = useState(null);
  const [add, setAdd] = useState("");
  const [remove, setRemove] = useState("");

  const load = useCallback(async () => {
    try {
      setBroker(await marketBroker(market));
    } catch {
      /* ignore */
    }
  }, [market]);
  useEffect(() => {
    setBroker(null);
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const cover = broker ? big(broker.CoverAvailable) : 0n;
  const debt = broker ? big(broker.DebtTotal) : 0n;
  const minimum = broker ? requiredCover(broker) : 0n;
  const below = minimum > 0n && cover < minimum;
  const fill = minimum > 0n ? Math.min(100, Number((cover * 100n) / (minimum > cover ? minimum : cover || 1n))) : cover > 0n ? 100 : 0;

  const addValid = isPositiveAmount(asset, add);
  const removeValid = isPositiveAmount(asset, remove);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">First-loss cover</h1>
            <p className="mt-1 text-muted-foreground">
              Junior capital that absorbs loan losses before any lender is touched. Keeping it above
              the minimum lets the desk keep lending.
            </p>
          </div>

          <MarketSelect value={market} onChange={setMarket} />

          <Card>
            <CardContent className="space-y-4 p-6">
              <div className="flex items-baseline justify-between">
                <div>
                  <p className="text-3xl font-semibold tabular-nums">{formatAmount(asset, cover)} {sym}</p>
                  <p className="text-xs text-muted-foreground">protecting {formatAmount(asset, debt)} {sym} of loans</p>
                </div>
                <p className={`text-sm ${below ? "text-destructive" : "text-emerald-600"}`}>
                  {minimum === 0n ? "No loans yet" : below ? "Below minimum" : "Healthy"}
                </p>
              </div>
              <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                <div className={`h-full rounded-full ${below ? "bg-destructive" : "bg-emerald-500"}`} style={{ width: `${fill}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">
                Minimum required now: {formatAmount(asset, minimum)} {sym}.
                {below && " New loans pause until cover recovers."}
              </p>
            </CardContent>
          </Card>

          {isOperator ? (
            <div className="grid gap-6 sm:grid-cols-2">
              <Card>
                <CardContent className="space-y-3 p-6">
                  <h2 className="font-medium">Add cover</h2>
                  <div className="space-y-1.5">
                    <Label htmlFor="add">Amount ({sym})</Label>
                    <Input id="add" inputMode="decimal" value={add} onChange={(e) => setAdd(e.target.value.trim())} placeholder="0.00" />
                  </div>
                  <TxButton
                    label="Add cover"
                    explain={explain}
                    disabled={!isConnected || !addValid}
                    tx={() => ({ TransactionType: "LoanBrokerCoverDeposit", Account: address, LoanBrokerID: market.brokerId, Amount: assetAmount(asset, toBaseUnits(asset, add)) })}
                    onResult={() => { setAdd(""); load(); }}
                  />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="space-y-3 p-6">
                  <h2 className="font-medium">Withdraw cover</h2>
                  <div className="space-y-1.5">
                    <Label htmlFor="rm">Amount ({sym})</Label>
                    <Input id="rm" inputMode="decimal" value={remove} onChange={(e) => setRemove(e.target.value.trim())} placeholder="0.00" />
                  </div>
                  <p className="text-xs text-muted-foreground">Can’t drop cover below the minimum while loans are outstanding.</p>
                  <TxButton
                    label="Withdraw"
                    variant="outline"
                    explain={explain}
                    disabled={!isConnected || !removeValid}
                    tx={() => ({ TransactionType: "LoanBrokerCoverWithdraw", Account: address, LoanBrokerID: market.brokerId, Amount: assetAmount(asset, toBaseUnits(asset, remove)) })}
                    onResult={() => { setRemove(""); load(); }}
                  />
                </CardContent>
              </Card>
            </div>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              First-loss cover is provided and managed by the desk that runs this market. Connect the
              desk account to add or withdraw it.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
