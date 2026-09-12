"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { MARKET } from "../lib/market";
import { marketVault, marketBroker, utilisation } from "../lib/product";
import { assetSymbol, formatAmount } from "../lib/asset";
import { Card, CardContent } from "../components/ui/card";
import { buttonVariants } from "../components/ui/button";

const big = (v) => BigInt(v ?? "0");
const asset = MARKET.asset;
const sym = assetSymbol(asset);
const xrp = (base) => formatAmount(asset, base);

export default function Home() {
  const [vault, setVault] = useState(null);
  const [broker, setBroker] = useState(null);

  useEffect(() => {
    let on = true;
    marketVault(MARKET).then((v) => on && setVault(v)).catch(() => {});
    marketBroker(MARKET).then((b) => on && setBroker(b)).catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const tvl = vault ? big(vault.AssetsTotal) : 0n;
  const util = vault ? utilisation(vault) : 0;
  const protection = broker ? big(broker.CoverAvailable) : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-4xl py-16 space-y-14">
          <section className="text-center space-y-5">
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
              Lend and borrow XRP,
              <br />
              protected by first-loss capital.
            </h1>
            <p className="mx-auto max-w-xl text-muted-foreground">
              Earn yield from real borrower interest, cushioned by a junior layer that takes losses
              before you. Or borrow against the vault and repay on your own schedule.
            </p>
            <div className="flex items-center justify-center gap-3">
              <Link href="/earn" className={buttonVariants({ size: "lg" })}>Start earning</Link>
              <Link href="/borrow" className={buttonVariants({ size: "lg", variant: "outline" })}>Borrow XRP</Link>
            </div>
          </section>

          <section className="grid grid-cols-3 gap-4">
            <Card>
              <CardContent className="p-5 text-center">
                <p className="text-xs text-muted-foreground">Total deposited</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{xrp(tvl)}</p>
                <p className="text-xs text-muted-foreground">XRP</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 text-center">
                <p className="text-xs text-muted-foreground">Lent out</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{(util * 100).toFixed(0)}%</p>
                <p className="text-xs text-muted-foreground">of the pool</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-5 text-center">
                <p className="text-xs text-muted-foreground">First-loss protection</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-600">{protection != null ? xrp(protection) : "—"}</p>
                <p className="text-xs text-muted-foreground">XRP</p>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 sm:grid-cols-2">
            <Link href="/earn" className="block">
              <Card className="h-full transition-colors hover:border-foreground/40">
                <CardContent className="space-y-2 p-6">
                  <h2 className="text-lg font-semibold">Earn</h2>
                  <p className="text-sm text-muted-foreground">
                    Deposit XRP and earn borrower interest. Withdraw anytime there is available
                    liquidity. Your deposit is protected by first-loss cover.
                  </p>
                  <span className="text-sm font-medium">Deposit →</span>
                </CardContent>
              </Card>
            </Link>
            <Link href="/borrow" className="block">
              <Card className="h-full transition-colors hover:border-foreground/40">
                <CardContent className="space-y-2 p-6">
                  <h2 className="text-lg font-semibold">Borrow</h2>
                  <p className="text-sm text-muted-foreground">
                    Draw a loan from the vault and repay in installments, or pay off early. You sign;
                    the desk approves instantly.
                  </p>
                  <span className="text-sm font-medium">Get a loan →</span>
                </CardContent>
              </Card>
            </Link>
          </section>

          <section className="grid gap-6 sm:grid-cols-3 text-sm">
            <div>
              <p className="font-medium">1 · Lenders deposit</p>
              <p className="text-muted-foreground">Senior capital pools in the vault and earns yield.</p>
            </div>
            <div>
              <p className="font-medium">2 · Borrowers draw</p>
              <p className="text-muted-foreground">Loans pay interest back into the pool.</p>
            </div>
            <div>
              <p className="font-medium">3 · First-loss absorbs</p>
              <p className="text-muted-foreground">If a loan defaults, junior cover takes the hit before lenders.</p>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
