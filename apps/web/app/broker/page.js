"use client";

// Phase 6.2 — Broker Cover Console. The junior provider's screen: post and
// withdraw first-loss cover, and watch the cover-minimum guardrail as a live
// gauge. Independent of every other UI/backend phase: it takes a LoanBrokerID
// (paste or `?broker=`) and the connected wallet (the broker owner), and reads
// only the LoanBroker ledger entry.

import { useCallback, useEffect, useState } from "react";
import { Header } from "../../components/Header";
import { NetworkBanner, StatCard, AmountInput, TxButton } from "../../components/lending";
import { useWallet } from "../../components/providers/WalletProvider";
import { readBroker, requiredCover, coverRatio } from "../../lib/lending-read";
import { formatDrops, groupThousands, formatRatePct, shortId } from "../../lib/format";
import { isDemoEnabled, seedScenario } from "../../lib/scenario";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import { Info } from "lucide-react";

const POLL_MS = 6000;

/** `?broker=` from the page URL (client-side only), for a linkable console. */
function brokerIdFromUrl() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("broker") || "";
}

export default function BrokerPage() {
  const { walletManager, isConnected } = useWallet();
  const address = walletManager?.account?.address || null;

  const [brokerIdInput, setBrokerIdInput] = useState(() => brokerIdFromUrl());
  const [brokerId, setBrokerId] = useState(() => brokerIdFromUrl());
  const [broker, setBroker] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [demoStatus, setDemoStatus] = useState(() =>
    !brokerIdFromUrl() && isDemoEnabled() ? "seeding" : null,
  );

  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  // Seed a throwaway demo scenario behind `?demo` so the screen has something to
  // show (dev-only; never a source another phase reads). A `?broker=` id is
  // applied synchronously via the lazy initializers above, so this only runs for
  // the demo case.
  useEffect(() => {
    if (brokerIdFromUrl() || !isDemoEnabled()) return;
    seedScenario()
      .then(({ brokerId: seededId }) => {
        setBrokerIdInput(seededId);
        setBrokerId(seededId);
        setDemoStatus("done");
      })
      .catch((err) => setDemoStatus(`error: ${err instanceof Error ? err.message : String(err)}`));
  }, []);

  // Read-after-write for the deposit/withdraw handlers.
  const refresh = useCallback(async () => {
    if (!brokerId) return;
    try {
      const b = await readBroker(brokerId);
      setBroker(b);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [brokerId]);

  // Poll on a timer. `poll` is a plain function local to this effect (not a
  // useCallback) so every setState here happens inside a Promise callback,
  // never synchronously in the effect body.
  useEffect(() => {
    if (!brokerId) return;
    let cancelled = false;
    function poll() {
      readBroker(brokerId)
        .then((b) => {
          if (cancelled) return;
          setBroker(b);
          setLoadError(null);
        })
        .catch((err) => {
          if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
        });
    }
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [brokerId]);

  const handleLoad = (e) => {
    e.preventDefault();
    setBrokerId(brokerIdInput.trim());
  };

  const onDepositResult = useCallback(
    ({ code }) => {
      if (code === "tesSUCCESS") setDepositAmount("");
      refresh();
    },
    [refresh],
  );

  const onWithdrawResult = useCallback(
    ({ code }) => {
      if (code === "tesSUCCESS") setWithdrawAmount("");
      refresh();
    },
    [refresh],
  );

  const coverAvailable = broker ? BigInt(broker.CoverAvailable ?? "0") : 0n;
  const debtTotal = broker ? BigInt(broker.DebtTotal ?? "0") : 0n;
  const requiredMin = broker ? requiredCover(broker) : 0n;
  const ratio = broker ? coverRatio(broker) : null; // null when DebtTotal is 0 (no minimum yet)
  const belowMinimum = requiredMin > 0n && coverAvailable < requiredMin;
  const isOwner = broker && address ? broker.Owner === address : null;

  // Gauge fill: a visual layout ratio (bar width %), not a money figure, so a
  // plain Number from an already-rounded display string is fine here.
  const scaleMaxBig = (coverAvailable > requiredMin ? coverAvailable : requiredMin) || 1n;
  const scalePad = (scaleMaxBig * 6n) / 5n || 1n;
  const fillPct = Math.min(100, Math.max(0, Number(((coverAvailable * 100n) / scalePad).toString())));
  const minPct = Math.min(100, Math.max(0, Number(((requiredMin * 100n) / scalePad).toString())));

  const depositValid = /^\d+$/.test(depositAmount) && depositAmount !== "" && depositAmount !== "0";
  const depositDisabled = !isConnected || !broker || !depositValid;

  const withdrawValid = /^\d+$/.test(withdrawAmount) && withdrawAmount !== "" && withdrawAmount !== "0";
  const withdrawBig = withdrawValid ? BigInt(withdrawAmount) : 0n;
  const resultingCover = coverAvailable - withdrawBig;
  const withdrawWouldBreach = withdrawValid && resultingCover < requiredMin;
  const withdrawDisabled = !isConnected || !broker || !withdrawValid;

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="flex-1">
        <div className="container max-w-4xl py-6 space-y-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Broker Cover Console</h1>
            <p className="text-muted-foreground text-sm">
              Post first-loss cover and watch the minimum-cover guardrail live &mdash; the junior
              provider absorbs losses before any lender does.
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
              <CardTitle className="text-base">Loan broker</CardTitle>
              <CardDescription>Paste a LoanBrokerID, or open this page with `?broker=&lt;id&gt;`.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex gap-2" onSubmit={handleLoad}>
                <Input
                  value={brokerIdInput}
                  onChange={(e) => setBrokerIdInput(e.target.value.trim())}
                  placeholder="Loan broker ledger index (64 hex chars)"
                  className="font-mono text-xs"
                />
                <Button type="submit" variant="secondary">
                  Load
                </Button>
              </form>
              {broker && (
                <p className="mt-2 text-xs text-muted-foreground break-all">
                  Owner: <span className="font-mono">{shortId(broker.Owner, 10)}</span> &middot; Vault:{" "}
                  <span className="font-mono">{shortId(broker.VaultID, 10)}</span>
                </p>
              )}
              {broker && isConnected && isOwner === false && (
                <Alert variant="warning" className="mt-3">
                  <AlertTitle>Connected wallet is not the broker owner</AlertTitle>
                  <AlertDescription>
                    Only <span className="font-mono">{shortId(broker.Owner, 10)}</span> may deposit or
                    withdraw cover. You can still try &mdash; the ledger will reject with{" "}
                    <code>tecNO_PERMISSION</code>.
                  </AlertDescription>
                </Alert>
              )}
              {loadError && (
                <Alert variant="destructive" className="mt-3">
                  <AlertTitle>Could not read broker</AlertTitle>
                  <AlertDescription className="break-all">{loadError}</AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>

          {broker && (
            <>
              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Cover gauge</h2>
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <span>
                        <span className="font-mono font-semibold">
                          {groupThousands(formatDrops(coverAvailable.toString()))} XRP
                        </span>{" "}
                        available
                      </span>
                      <span className="text-muted-foreground">
                        minimum required:{" "}
                        <span className="font-mono">{groupThousands(formatDrops(requiredMin.toString()))} XRP</span>
                      </span>
                    </div>
                    <div className="relative h-4 w-full overflow-hidden rounded-full bg-red-100">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-full ${belowMinimum ? "bg-red-500" : "bg-emerald-500"}`}
                        style={{ width: `${fillPct}%` }}
                      />
                      <div className="absolute inset-y-0 w-0.5 bg-red-700" style={{ left: `${minPct}%` }} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {requiredMin === 0n
                        ? "No debt outstanding — the minimum is not yet binding."
                        : belowMinimum
                          ? "Cover is below the required minimum: the broker cannot originate new loans and fees route into the cover pool until it recovers."
                          : `Cover ratio (derived): ${ratio ?? "—"} of the required minimum.`}
                    </p>
                  </CardContent>
                </Card>
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium text-muted-foreground">Parameters</h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <StatCard
                    label="Cover rate minimum"
                    value={`${formatRatePct(broker.CoverRateMinimum) ?? "0"}%`}
                    sub="of DebtTotal that must stay covered"
                  />
                  <StatCard
                    label="Cover rate liquidation"
                    value={`${formatRatePct(broker.CoverRateLiquidation) ?? "0"}%`}
                    sub="of the minimum liquidated per default"
                  />
                  <StatCard
                    label="Management fee rate"
                    value={`${formatRatePct(broker.ManagementFeeRate, 10000) ?? "0"}%`}
                  />
                  <StatCard label="Debt total" value={`${groupThousands(formatDrops(debtTotal.toString()))} XRP`} />
                  <StatCard
                    label="Debt maximum"
                    value={`${groupThousands(formatDrops(broker.DebtMaximum ?? "0"))} XRP`}
                  />
                </div>
              </section>

              <section className="grid gap-6 md:grid-cols-2">
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Deposit cover</CardTitle>
                    <CardDescription>First-loss capital the broker owner posts.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <AmountInput
                      id="cover-deposit"
                      label="Deposit amount (drops)"
                      value={depositAmount}
                      onChange={setDepositAmount}
                    />
                    <TxButton
                      label="Deposit cover"
                      disabled={depositDisabled}
                      tx={() => ({
                        TransactionType: "LoanBrokerCoverDeposit",
                        Account: address,
                        LoanBrokerID: brokerId,
                        Amount: depositAmount,
                      })}
                      onResult={onDepositResult}
                    />
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Withdraw cover</CardTitle>
                    <CardDescription>Rejected if it would drop cover below the minimum.</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <AmountInput
                      id="cover-withdraw"
                      label="Withdraw amount (drops)"
                      value={withdrawAmount}
                      onChange={setWithdrawAmount}
                    />
                    {withdrawWouldBreach && (
                      <Alert variant="warning">
                        <AlertTitle>This will likely be rejected</AlertTitle>
                        <AlertDescription>
                          Withdrawing this much would drop cover to{" "}
                          <span className="font-mono">
                            {groupThousands(formatDrops((resultingCover < 0n ? 0n : resultingCover).toString()))} XRP
                          </span>
                          , below the required minimum of{" "}
                          <span className="font-mono">{groupThousands(formatDrops(requiredMin.toString()))} XRP</span>.
                          Expect <code>tecINSUFFICIENT_FUNDS</code> &mdash; a cover-ratio breach, not a balance
                          shortfall. You can still submit to see the guardrail reject it.
                        </AlertDescription>
                      </Alert>
                    )}
                    <TxButton
                      label="Withdraw cover"
                      variant="outline"
                      disabled={withdrawDisabled}
                      tx={() => ({
                        TransactionType: "LoanBrokerCoverWithdraw",
                        Account: address,
                        LoanBrokerID: brokerId,
                        Amount: withdrawAmount,
                      })}
                      onResult={onWithdrawResult}
                    />
                  </CardContent>
                </Card>
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
