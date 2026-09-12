"use client";

// Protection: a tranche waterfall that makes the first-loss model visible. Junior cover
// sits below senior lender capital; a hypothetical loss eats the junior tranche first
// and only spills into senior lenders once cover is exhausted. Live per-market data.

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { MarketSelect } from "../../components/MarketSelect";
import { useWallet } from "../../components/providers/WalletProvider";
import { MARKETS } from "../../lib/market";
import { marketVault, marketBroker } from "../../lib/product";
import { requiredCover } from "../../lib/lending-read";
import { assetSymbol, formatAmount } from "../../lib/asset";
import { Card, CardContent } from "../../components/ui/card";

const POLL_MS = 8000;
const big = (v) => BigInt(v ?? "0");
// Percent (0..100) of part within whole, as a Number for layout only.
const pct = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : 0);

function Legend({ color, label, value }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="h-3 w-3 rounded-sm" style={{ background: color }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="ml-auto font-medium tabular-nums">{value}</span>
    </div>
  );
}

export default function ProtectionPage() {
  useWallet();
  const [market, setMarket] = useState(MARKETS[0]);
  const asset = market.asset;
  const sym = assetSymbol(asset);

  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);
  const [lossPct, setLossPct] = useState(0); // slider 0..100 of the at-risk amount

  const load = useCallback(async () => {
    const [v, b] = await Promise.all([marketVault(market).catch(() => null), marketBroker(market).catch(() => null)]);
    setVault(v);
    setBroker(b);
  }, [market]);
  useEffect(() => {
    setVault(null);
    setBroker(null);
    setLossPct(0);
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const senior = vault ? big(vault.AssetsTotal) : 0n; // lender capital
  const junior = broker ? big(broker.CoverAvailable) : 0n; // first-loss cover
  const debt = broker ? big(broker.DebtTotal) : 0n; // at risk (what is lent out)
  const minimum = broker ? requiredCover(broker) : 0n;

  // A loss cannot exceed what is lent out. Slide within [0, debt]; cover absorbs first.
  const loss = (big(BigInt(Math.round(lossPct * 100))) * debt) / 10000n;
  const coverAbsorb = loss < junior ? loss : junior;
  const lenderLoss = loss > junior ? loss - junior : 0n;
  const coverRemaining = junior - coverAbsorb;
  const lenderLossPct = pct(lenderLoss, senior);

  const stackTotal = junior + senior;
  const juniorWidth = pct(junior, stackTotal);
  const minMarker = pct(minimum, stackTotal);
  // Loss overlay spans from the left across junior then senior, as a share of the stack.
  const lossWidth = pct(loss, stackTotal);
  const coverBandCovered = Math.min(juniorWidth, lossWidth);

  const exhausted = junior > 0n && loss >= junior;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-3xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Loss protection</h1>
            <p className="mt-1 text-muted-foreground">
              How the tranches absorb a loss. Junior first-loss cover is wiped out before any senior
              lender is touched. Drag to see a hypothetical default work through the stack.
            </p>
          </div>

          <MarketSelect value={market} onChange={setMarket} />

          <Card>
            <CardContent className="space-y-5 p-6">
              {/* Capital stack: junior (left) then senior (right); loss eats from the left. */}
              <div>
                <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>Junior cover absorbs first</span>
                  <span>Senior lenders</span>
                </div>
                <div className="relative h-16 w-full overflow-hidden rounded-lg border border-border/60">
                  {/* base tranches */}
                  <div className="absolute inset-y-0 left-0 bg-emerald-500/30" style={{ width: `${juniorWidth}%` }} />
                  <div className="absolute inset-y-0 bg-sky-500/25" style={{ left: `${juniorWidth}%`, right: 0 }} />
                  {/* loss overlay: red over whatever it has consumed */}
                  <div className="absolute inset-y-0 left-0 bg-destructive/70" style={{ width: `${lossWidth}%` }} />
                  {/* junior/senior divider */}
                  <div className="absolute inset-y-0 w-px bg-background/80" style={{ left: `${juniorWidth}%` }} />
                  {/* minimum-cover marker */}
                  {minimum > 0n && (
                    <div className="absolute inset-y-0 w-0.5 bg-amber-500" style={{ left: `${minMarker}%` }} title="minimum cover" />
                  )}
                  <div className="absolute inset-0 flex items-center justify-between px-3 text-xs font-medium text-foreground/80">
                    <span>{formatAmount(asset, junior)} {sym}</span>
                    <span>{formatAmount(asset, senior)} {sym}</span>
                  </div>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">Amber line marks the minimum cover the desk must keep while loans are outstanding. Red shows the modelled loss ({coverBandCovered > 0 ? "eating junior cover first" : "none yet"}).</p>
              </div>

              {/* Loss slider */}
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <label htmlFor="loss" className="text-muted-foreground">Hypothetical loss</label>
                  <span className="font-medium tabular-nums">{formatAmount(asset, loss)} {sym}</span>
                </div>
                <input
                  id="loss"
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={lossPct}
                  onChange={(e) => setLossPct(Number(e.target.value))}
                  disabled={debt === 0n}
                  className="w-full accent-destructive"
                />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>0</span>
                  <span>at risk: {formatAmount(asset, debt)} {sym}</span>
                </div>
              </div>

              {/* Readout */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-emerald-500/10 p-3">
                  <p className="text-xs text-muted-foreground">Absorbed by cover</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums text-emerald-600">{formatAmount(asset, coverAbsorb)} {sym}</p>
                  <p className="text-[11px] text-muted-foreground">{formatAmount(asset, coverRemaining)} {sym} cover left</p>
                </div>
                <div className={`rounded-lg p-3 ${lenderLoss > 0n ? "bg-destructive/10" : "bg-muted"}`}>
                  <p className="text-xs text-muted-foreground">Hits senior lenders</p>
                  <p className={`mt-1 text-lg font-semibold tabular-nums ${lenderLoss > 0n ? "text-destructive" : ""}`}>{formatAmount(asset, lenderLoss)} {sym}</p>
                  <p className="text-[11px] text-muted-foreground">{lenderLossPct.toFixed(2)}% of deposits</p>
                </div>
                <div className="rounded-lg bg-muted p-3">
                  <p className="text-xs text-muted-foreground">Status</p>
                  <p className={`mt-1 text-lg font-semibold ${exhausted ? "text-destructive" : "text-emerald-600"}`}>{exhausted ? "Cover exhausted" : "Lenders protected"}</p>
                  <p className="text-[11px] text-muted-foreground">{exhausted ? "senior capital now absorbs losses" : "junior cover is covering the loss"}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-3 text-sm">
            <div>
              <p className="font-medium text-emerald-600">Junior · first loss</p>
              <p className="text-muted-foreground">Provided by the desk. Absorbs defaults before lenders, and is liquidated to the vault on a default.</p>
            </div>
            <div>
              <p className="font-medium text-sky-600">Senior · lenders</p>
              <p className="text-muted-foreground">Your deposits. Only exposed once junior cover is fully used up.</p>
            </div>
            <div>
              <p className="font-medium text-amber-600">Minimum cover</p>
              <p className="text-muted-foreground">Below this line the desk cannot originate new loans until cover is topped up.</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
