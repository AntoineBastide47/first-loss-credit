"use client";

// Phase 6.4 — Risk Monitor. A read-only investor-facing dashboard: portfolio
// health and the first-loss waterfall (how junior cover absorbs a default
// before senior lenders take a realized loss). Independent of every other UI
// phase: it takes a VaultID, a LoanBrokerID, and 0+ LoanIDs (paste or URL
// params), reads only those ledger entries, and never signs anything.
//
// The ledger stores no "DefaultAmount" or "DefaultCovered" field — §3.10's
// waterfall split only exists as the delta a LoanManage-default transaction
// makes to LoanBroker.CoverAvailable and Vault.AssetsTotal (impl/part-1/1.4
// reconstructs it the same way: before/after reads around the event). Since
// this screen only polls, it detects "a default just happened" itself: each
// tick compares a tracked loan's Flags against the previous tick, and when
// lsfLoanDefault newly appears, the broker/vault deltas between those same two
// ticks are that default's covered-vs-loss split. A dashboard opened cold,
// after the default already happened elsewhere, has no such transition to
// observe and falls back to showing the current post-default state only.

import { useCallback, useEffect, useRef, useState } from "react";
import { LoanFlags } from "xrpl";
import { Header } from "../../components/Header";
import { NetworkBanner, StatCard } from "../../components/lending";
import {
  readVault,
  readBroker,
  readLoan,
  sharePrice,
  utilisation,
  requiredCover,
  coverRatio,
} from "../../lib/lending-read";
import {
  formatDrops,
  groupThousands,
  formatRatePct,
  formatRippleTime,
  shortId,
  ratioString,
} from "../../lib/format";
import { isDemoEnabled, seedScenario } from "../../lib/scenario";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Info } from "lucide-react";

const POLL_MS = 6000;
const RIPPLE_EPOCH_OFFSET = 946684800;
const big = (v) => BigInt(v ?? "0");

function idsFromUrl(param) {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(param) || "";
}

/** A small "view raw ledger data" affordance; no library, just <details>. */
function ViewSource({ data }) {
  if (!data) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground">View source</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/40 p-2">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  );
}

/** A single-value bar (0 .. paddedMax), optionally with a red "consumed/loss" segment. */
function Bar({ value, consumed = 0n, max }) {
  const padded = (max > 0n ? max : 1n) * 6n / 5n || 1n;
  const pct = (n) => Math.min(100, Math.max(0, Number((n * 100n) / padded)));
  return (
    <div className="relative h-4 w-full overflow-hidden rounded-full bg-muted">
      <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-500" style={{ width: `${pct(value)}%` }} />
      {consumed > 0n && (
        <div
          className="absolute inset-y-0 rounded-full bg-red-500"
          style={{ left: `${pct(value)}%`, width: `${pct(consumed)}%` }}
        />
      )}
    </div>
  );
}

function loanStatus(loan) {
  const flags = Number(loan.Flags ?? 0);
  if (flags & LoanFlags.lsfLoanDefault) return { label: "Defaulted", variant: "destructive" };
  if (flags & LoanFlags.lsfLoanImpaired) return { label: "Impaired", variant: "warning" };
  return { label: "Current", variant: "success" };
}

/** origination → due → grace-end ribbon for the current payment cycle. */
function Timeline({ loan, nowRipple }) {
  const cycleStart = Number(loan.PreviousPaymentDueDate ?? loan.StartDate ?? 0);
  const due = Number(loan.NextPaymentDueDate ?? 0);
  const graceEnd = due + Number(loan.GracePeriod ?? 0);
  const span = Math.max(graceEnd - cycleStart, 1);
  const pos = (t) => Math.min(100, Math.max(0, ((t - cycleStart) / span) * 100));
  return (
    <div className="relative h-2 w-full rounded-full bg-muted">
      <div className="absolute inset-y-0 left-0 rounded-full bg-emerald-400" style={{ width: `${pos(due)}%` }} />
      <div
        className="absolute inset-y-0 rounded-full bg-amber-400"
        style={{ left: `${pos(due)}%`, width: `${Math.max(0, pos(graceEnd) - pos(due))}%` }}
      />
      <div
        className="absolute -top-1 h-4 w-0.5 bg-foreground"
        style={{ left: `${pos(nowRipple)}%` }}
        title="now"
      />
    </div>
  );
}

export default function RiskPage() {
  const [vaultIdInput, setVaultIdInput] = useState(() => idsFromUrl("vault"));
  const [vaultId, setVaultId] = useState(() => idsFromUrl("vault"));
  const [vault, setVault] = useState(null);
  const [vaultError, setVaultError] = useState(null);

  const [brokerIdInput, setBrokerIdInput] = useState(() => idsFromUrl("broker"));
  const [brokerId, setBrokerId] = useState(() => idsFromUrl("broker"));
  const [broker, setBroker] = useState(null);
  const [brokerError, setBrokerError] = useState(null);

  const [loanIdInput, setLoanIdInput] = useState("");
  const [loanIdsText, setLoanIdsText] = useState(() => idsFromUrl("loans"));
  const [loans, setLoans] = useState({}); // { [loanId]: loanObject }
  const [loanErrors, setLoanErrors] = useState({});

  const [nowRipple, setNowRipple] = useState(0);
  const [defaultEvents, setDefaultEvents] = useState({}); // { [loanId]: { covered, loss, at } }

  const [demoStatus, setDemoStatus] = useState(() =>
    !idsFromUrl("vault") && !idsFromUrl("broker") && isDemoEnabled() ? "seeding" : null,
  );

  // Last-seen snapshot per loan, to detect a default transition between ticks.
  const prevRef = useRef({ broker: null, vault: null, loanFlags: {} });

  const loanIds = loanIdsText.split(",").map((s) => s.trim()).filter(Boolean);

  useEffect(() => {
    if (idsFromUrl("vault") || idsFromUrl("broker") || !isDemoEnabled()) return;
    seedScenario()
      .then(({ vaultId: v, brokerId: b, loanId: l }) => {
        setVaultIdInput(v);
        setVaultId(v);
        setBrokerIdInput(b);
        setBrokerId(b);
        setLoanIdsText(l);
        setDemoStatus("done");
      })
      .catch((err) => setDemoStatus(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  const handleLoadVault = (e) => {
    e.preventDefault();
    setVaultId(vaultIdInput.trim());
  };
  const handleLoadBroker = (e) => {
    e.preventDefault();
    setBrokerId(brokerIdInput.trim());
  };
  const handleAddLoan = (e) => {
    e.preventDefault();
    const id = loanIdInput.trim();
    if (!id || loanIds.includes(id)) return;
    setLoanIdsText(loanIds.concat(id).join(","));
    setLoanIdInput("");
  };
  const handleRemoveLoan = (id) => {
    setLoanIdsText(loanIds.filter((x) => x !== id).join(","));
  };

  // One combined poll tick: read vault + broker + every tracked loan together,
  // so a default transition can be attributed to the same before/after pair.
  useEffect(() => {
    let cancelled = false;

    function poll() {
      const rippleNow = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH_OFFSET;

      Promise.all([
        vaultId ? readVault(vaultId).catch((err) => ({ __error: err })) : Promise.resolve(null),
        brokerId ? readBroker(brokerId).catch((err) => ({ __error: err })) : Promise.resolve(null),
        Promise.all(
          loanIds.map((id) => readLoan(id).then((l) => [id, l]).catch((err) => [id, { __error: err }])),
        ),
      ]).then(([v, b, loanPairs]) => {
        if (cancelled) return;
        setNowRipple(rippleNow);

        if (v) {
          if (v.__error) setVaultError(v.__error.message || String(v.__error));
          else {
            setVault(v);
            setVaultError(null);
          }
        }
        if (b) {
          if (b.__error) setBrokerError(b.__error.message || String(b.__error));
          else {
            setBroker(b);
            setBrokerError(null);
          }
        }

        const nextLoans = {};
        const nextErrors = {};
        const newEvents = {};
        for (const [id, l] of loanPairs) {
          if (l.__error) {
            nextErrors[id] = l.__error.message || String(l.__error);
            continue;
          }
          nextLoans[id] = l;

          const prevFlags = prevRef.current.loanFlags[id];
          const wasDefaulted = prevFlags != null && (prevFlags & LoanFlags.lsfLoanDefault) !== 0;
          const isDefaulted = (Number(l.Flags ?? 0) & LoanFlags.lsfLoanDefault) !== 0;
          if (isDefaulted && !wasDefaulted && prevFlags != null && prevRef.current.broker && prevRef.current.vault) {
            const covered = big(prevRef.current.broker.CoverAvailable) - big(b?.CoverAvailable);
            const loss = big(prevRef.current.vault.AssetsTotal) - big(v?.AssetsTotal);
            newEvents[id] = { covered, loss, at: rippleNow };
          }
        }
        setLoans((prev) => ({ ...prev, ...nextLoans }));
        setLoanErrors((prev) => ({ ...prev, ...nextErrors }));
        if (Object.keys(newEvents).length) {
          setDefaultEvents((prev) => ({ ...prev, ...newEvents }));
        }

        prevRef.current = {
          broker: b && !b.__error ? b : prevRef.current.broker,
          vault: v && !v.__error ? v : prevRef.current.vault,
          loanFlags: {
            ...prevRef.current.loanFlags,
            ...Object.fromEntries(loanPairs.filter(([, l]) => !l.__error).map(([id, l]) => [id, Number(l.Flags ?? 0)])),
          },
        };
      });
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // loanIds is derived from loanIdsText each render; depend on the string form
    // so this effect doesn't re-fire on every render from a new array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, brokerId, loanIdsText]);

  const assetsTotal = vault ? big(vault.AssetsTotal) : 0n;
  const assetsAvailable = vault ? big(vault.AssetsAvailable) : 0n;
  const lossUnrealized = vault ? big(vault.LossUnrealized) : 0n;
  const coverAvailable = broker ? big(broker.CoverAvailable) : 0n;
  const requiredMin = broker ? requiredCover(broker) : 0n;
  const utilPct = vault && assetsTotal > 0n ? ratioString((assetsTotal - assetsAvailable) * 100n, assetsTotal, 2) : null;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">
        <div className="container max-w-4xl py-6 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Risk Monitor</h1>
            <p className="text-muted-foreground text-sm">
              Read-only: portfolio health and the first-loss waterfall. No wallet, no writes.
            </p>
          </div>

          <NetworkBanner />

          {demoStatus === "seeding" && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertTitle>Seeding demo scenario</AlertTitle>
              <AlertDescription>
                Funding accounts and building a vault + broker + loan on the devnet. This can take
                up to a minute.
              </AlertDescription>
            </Alert>
          )}
          {typeof demoStatus === "string" && demoStatus.startsWith("error:") && (
            <Alert variant="destructive">
              <AlertTitle>Demo seed failed</AlertTitle>
              <AlertDescription>{demoStatus.slice("error: ".length)}</AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Ids to monitor</CardTitle>
              <CardDescription>Paste ids, or open with `?vault=&amp;broker=&amp;loans=id1,id2`.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <form className="flex gap-2" onSubmit={handleLoadVault}>
                <Input
                  value={vaultIdInput}
                  onChange={(e) => setVaultIdInput(e.target.value.trim())}
                  placeholder="VaultID (64 hex chars)"
                  className="font-mono text-xs"
                />
                <Button type="submit" variant="secondary">
                  Load
                </Button>
              </form>
              <form className="flex gap-2" onSubmit={handleLoadBroker}>
                <Input
                  value={brokerIdInput}
                  onChange={(e) => setBrokerIdInput(e.target.value.trim())}
                  placeholder="LoanBrokerID (64 hex chars)"
                  className="font-mono text-xs"
                />
                <Button type="submit" variant="secondary">
                  Load
                </Button>
              </form>
              <form className="flex gap-2" onSubmit={handleAddLoan}>
                <Input
                  value={loanIdInput}
                  onChange={(e) => setLoanIdInput(e.target.value.trim())}
                  placeholder="LoanID (64 hex chars) — add as many as you want"
                  className="font-mono text-xs"
                />
                <Button type="submit" variant="secondary">
                  Add
                </Button>
              </form>
              {loanIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {loanIds.map((id) => (
                    <Badge key={id} variant="secondary" className="gap-1">
                      <span className="font-mono">{shortId(id, 6)}</span>
                      <button
                        type="button"
                        className="ml-1 text-muted-foreground hover:text-foreground"
                        onClick={() => handleRemoveLoan(id)}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {vaultError && (
                <Alert variant="destructive">
                  <AlertTitle>Could not read vault</AlertTitle>
                  <AlertDescription className="break-all">{vaultError}</AlertDescription>
                </Alert>
              )}
              {brokerError && (
                <Alert variant="destructive">
                  <AlertTitle>Could not read broker</AlertTitle>
                  <AlertDescription className="break-all">{brokerError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {vault && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Vault health</h2>
              <Card>
                <CardContent className="pt-6">
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StatCard label="Assets total" value={`${groupThousands(formatDrops(vault.AssetsTotal ?? "0"))} XRP`} />
                    <StatCard
                      label="Assets available"
                      value={`${groupThousands(formatDrops(vault.AssetsAvailable ?? "0"))} XRP`}
                    />
                    <StatCard label="Utilisation" value={utilPct ? `${utilPct}%` : "—"} sub="1 − available/total" />
                    <StatCard
                      label="Share price (derived)"
                      value={sharePrice(vault) ?? "—"}
                      sub="AssetsTotal ÷ shares"
                    />
                  </div>
                  {lossUnrealized !== 0n && (
                    <Alert variant="warning" className="mt-3">
                      <AlertTitle>Unrealized loss</AlertTitle>
                      <AlertDescription>
                        <span className="font-mono">{groupThousands(formatDrops(lossUnrealized.toString()))} XRP</span>{" "}
                        of impairment lowers redemption value until it is realized (default) or reversed.
                      </AlertDescription>
                    </Alert>
                  )}
                  <ViewSource data={vault} />
                </CardContent>
              </Card>
            </section>
          )}

          {broker && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Cover</h2>
              <Card>
                <CardContent className="pt-6 space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span>
                      <span className="font-mono font-semibold">{groupThousands(formatDrops(coverAvailable.toString()))} XRP</span>{" "}
                      cover available
                    </span>
                    <span className="text-muted-foreground">
                      minimum required: <span className="font-mono">{groupThousands(formatDrops(requiredMin.toString()))} XRP</span>
                    </span>
                  </div>
                  <Bar value={coverAvailable} max={coverAvailable > requiredMin ? coverAvailable : requiredMin} />
                  <div className="grid gap-3 sm:grid-cols-2">
                    <StatCard label="Cover ratio (derived)" value={coverRatio(broker) ?? "—"} />
                    <StatCard
                      label="Cover rate liquidation"
                      value={`${formatRatePct(broker.CoverRateLiquidation) ?? "0"}%`}
                      sub="of the minimum liquidated per default"
                    />
                  </div>
                  <ViewSource data={broker} />
                </CardContent>
              </Card>
            </section>
          )}

          {loanIds.length > 0 && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">Loans</h2>
              <div className="space-y-3">
                {loanIds.map((id) => {
                  const loan = loans[id];
                  const error = loanErrors[id];
                  if (error) {
                    return (
                      <Alert key={id} variant="destructive">
                        <AlertTitle>Could not read loan {shortId(id, 6)}</AlertTitle>
                        <AlertDescription className="break-all">{error}</AlertDescription>
                      </Alert>
                    );
                  }
                  if (!loan) return null;
                  const status = loanStatus(loan);
                  const due = Number(loan.NextPaymentDueDate ?? 0);
                  const graceEnd = due + Number(loan.GracePeriod ?? 0);
                  const overdueLabel =
                    status.label === "Current"
                      ? nowRipple > graceEnd
                        ? "past grace"
                        : nowRipple > due
                          ? "within grace"
                          : null
                      : null;
                  return (
                    <Card key={id}>
                      <CardContent className="pt-6 space-y-3">
                        <div className="flex flex-wrap items-center gap-2 justify-between">
                          <span className="font-mono text-xs text-muted-foreground">{shortId(id, 10)}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant={status.variant}>{status.label}</Badge>
                            {overdueLabel && <Badge variant="warning">{overdueLabel}</Badge>}
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <StatCard
                            label="Outstanding"
                            value={`${groupThousands(formatDrops(loan.TotalValueOutstanding ?? "0"))} XRP`}
                          />
                          <StatCard label="Next payment due" value={formatRippleTime(loan.NextPaymentDueDate) ?? "—"} />
                          <StatCard label="Payments remaining" value={String(loan.PaymentRemaining ?? 0)} />
                        </div>
                        <Timeline loan={loan} nowRipple={nowRipple} />
                        <ViewSource data={loan} />
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          )}

          {vault && broker && (
            <section>
              <h2 className="mb-2 text-sm font-medium text-muted-foreground">First-loss waterfall</h2>
              <Card>
                <CardContent className="pt-6 space-y-4">
                  {(() => {
                    const events = Object.values(defaultEvents);
                    const lastEvent = events.length ? events[events.length - 1] : null;
                    return (
                      <>
                        <div className="space-y-1.5">
                          <p className="text-xs text-muted-foreground">
                            Junior cover (first-loss capital) &mdash; absorbs losses before senior lenders do
                          </p>
                          <Bar
                            value={coverAvailable}
                            consumed={lastEvent && lastEvent.covered > 0n ? lastEvent.covered : 0n}
                            max={coverAvailable + (lastEvent?.covered ?? 0n)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-xs text-muted-foreground">
                            Senior assets (vault) &mdash; takes only the residual, after cover
                          </p>
                          <Bar
                            value={assetsTotal}
                            consumed={
                              lossUnrealized > 0n
                                ? lossUnrealized
                                : lastEvent && lastEvent.loss > 0n
                                  ? lastEvent.loss
                                  : 0n
                            }
                            max={assetsTotal + lossUnrealized + (lastEvent?.loss ?? 0n)}
                          />
                        </div>
                        {lastEvent ? (
                          <Alert>
                            <Info className="h-4 w-4" />
                            <AlertTitle>Last observed default</AlertTitle>
                            <AlertDescription>
                              Cover absorbed{" "}
                              <span className="font-mono">
                                {groupThousands(formatDrops(lastEvent.covered.toString()))} XRP
                              </span>
                              ; senior lenders realized a loss of{" "}
                              <span className="font-mono">
                                {groupThousands(formatDrops(lastEvent.loss.toString()))} XRP
                              </span>{" "}
                              (DefaultAmount = covered + loss ={" "}
                              <span className="font-mono">
                                {groupThousands(formatDrops((lastEvent.covered + lastEvent.loss).toString()))} XRP
                              </span>
                              ).
                            </AlertDescription>
                          </Alert>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {lossUnrealized > 0n
                              ? "An impairment has marked a paper loss (red, above) — no default has moved cover or realized a loss yet."
                              : "Healthy: no impairment or default observed while this page was open. This screen only sees a default's split if it happens while it is polling."}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
