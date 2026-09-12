"use client";

// Portfolio: broker-level aggregate exposure across every market and its loans. One row
// per market (deposits, lent, utilisation, cover health) plus the loan book underneath,
// and a top summary of loan counts and how many are at risk. Amounts stay in each
// market's own asset (an XRP total and a token total are not additive).

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { MARKETS } from "../../lib/market";
import { marketVault, marketBroker, knownLoans, utilisation } from "../../lib/product";
import { readLoan, requiredCover } from "../../lib/lending-read";
import { assetSymbol, formatAmount } from "../../lib/asset";
import { formatRippleTime } from "../../lib/format";
import { Card, CardContent } from "../../components/ui/card";

const POLL_MS = 8000;
const big = (v) => BigInt(v ?? "0");
const rippleNow = () => Math.floor(Date.now() / 1000) - 946684800;
const LSF_LOAN_DEFAULT = 0x00010000;

function statusOf(loan) {
  const now = rippleNow();
  const due = Number(loan.NextPaymentDueDate ?? 0);
  const graceEnd = due + Number(loan.GracePeriod ?? 0);
  if ((Number(loan.Flags) & LSF_LOAN_DEFAULT) !== 0) return "Defaulted";
  if (now > graceEnd) return "In default window";
  if (now > due) return "Overdue";
  return "On track";
}
const TONE = {
  "On track": "text-emerald-600",
  Overdue: "text-amber-600",
  "In default window": "text-destructive",
  Defaulted: "text-destructive",
};

async function loadMarket(market) {
  const [vault, broker] = await Promise.all([
    marketVault(market).catch(() => null),
    marketBroker(market).catch(() => null),
  ]);
  const loans = (
    await Promise.all(knownLoans(market).map((id) => readLoan(id).then((l) => ({ id, loan: l })).catch(() => null)))
  ).filter(Boolean);
  return { market, vault, broker, loans };
}

function Pill({ label, count, tone }) {
  if (!count) return null;
  return <span className={`rounded-full bg-muted px-2 py-0.5 text-xs ${tone}`}>{count} {label}</span>;
}

export default function PortfolioPage() {
  const [rows, setRows] = useState([]);

  const load = useCallback(async () => {
    setRows(await Promise.all(MARKETS.map(loadMarket)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const allLoans = rows.flatMap((r) => r.loans.map((x) => statusOf(x.loan)));
  const total = allLoans.length;
  const atRisk = allLoans.filter((s) => s !== "On track").length;
  const defaulted = allLoans.filter((s) => s === "Defaulted").length;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-4xl py-8 space-y-6">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Portfolio</h1>
            <p className="mt-1 text-muted-foreground">
              Total exposure across every market and its loans, read live from the ledger.
            </p>
          </div>

          <Card>
            <CardContent className="grid grid-cols-4 gap-4 p-6">
              <div><p className="text-xs text-muted-foreground">Markets</p><p className="mt-1 text-2xl font-semibold tabular-nums">{MARKETS.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Active loans</p><p className="mt-1 text-2xl font-semibold tabular-nums">{total}</p></div>
              <div><p className="text-xs text-muted-foreground">At risk</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${atRisk ? "text-amber-600" : ""}`}>{atRisk}</p></div>
              <div><p className="text-xs text-muted-foreground">Defaulted</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${defaulted ? "text-destructive" : ""}`}>{defaulted}</p></div>
            </CardContent>
          </Card>

          {rows.map(({ market, vault, broker, loans }) => {
            const asset = market.asset;
            const sym = assetSymbol(asset);
            const deposits = vault ? big(vault.AssetsTotal) : 0n;
            const available = vault ? big(vault.AssetsAvailable) : 0n;
            const lent = deposits - available;
            const cover = broker ? big(broker.CoverAvailable) : 0n;
            const minimum = broker ? requiredCover(broker) : 0n;
            const below = minimum > 0n && cover < minimum;
            const util = vault ? utilisation(vault) : 0;
            const counts = loans.reduce((m, x) => { const s = statusOf(x.loan); m[s] = (m[s] || 0) + 1; return m; }, {});

            return (
              <Card key={market.id}>
                <CardContent className="space-y-4 p-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{market.name}</h2>
                      <p className="text-xs text-muted-foreground">{sym} denominated</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Pill label="on track" count={counts["On track"]} tone={TONE["On track"]} />
                      <Pill label="overdue" count={counts.Overdue} tone={TONE.Overdue} />
                      <Pill label="in default window" count={counts["In default window"]} tone={TONE["In default window"]} />
                      <Pill label="defaulted" count={counts.Defaulted} tone={TONE.Defaulted} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div><p className="text-xs text-muted-foreground">Deposits</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, deposits)} {sym}</p></div>
                    <div><p className="text-xs text-muted-foreground">Lent out</p><p className="mt-1 font-semibold tabular-nums">{formatAmount(asset, lent)} {sym}</p></div>
                    <div><p className="text-xs text-muted-foreground">Cover</p><p className={`mt-1 font-semibold tabular-nums ${below ? "text-destructive" : "text-emerald-600"}`}>{formatAmount(asset, cover)} {sym}</p></div>
                    <div><p className="text-xs text-muted-foreground">Utilisation</p><p className="mt-1 font-semibold tabular-nums">{(util * 100).toFixed(0)}%</p></div>
                  </div>

                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-sky-500" style={{ width: `${Math.min(100, util * 100)}%` }} />
                  </div>

                  <div className="divide-y divide-border/60">
                    {loans.length === 0 && <p className="text-sm text-muted-foreground">No loans.</p>}
                    {loans.map(({ id, loan }) => {
                      const s = statusOf(loan);
                      return (
                        <div key={id} className="flex items-center justify-between py-2 text-sm">
                          <div>
                            <span className="font-medium tabular-nums">{formatAmount(asset, loan.PrincipalOutstanding)} {sym}</span>
                            <span className="text-muted-foreground"> · {loan.PaymentRemaining ?? 0} left · due {formatRippleTime(loan.NextPaymentDueDate)}</span>
                          </div>
                          <span className={`font-medium ${TONE[s]}`}>{s}</span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </main>
    </div>
  );
}
